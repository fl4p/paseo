/**
 * Read the summary Claude wrote when it compacted a session.
 *
 * A compaction leaves two things in the transcript: a `system` /
 * `compact_boundary` entry describing the event, and a synthetic user entry
 * flagged `isCompactSummary` that CONTAINS the summary text. Paseo's history
 * conversion deliberately drops the second one (it emits a compaction marker
 * instead, so the summary is not shown as if the user had typed it), which is
 * fine on screen but means the timeline no longer holds the semantic content
 * the compaction preserved.
 *
 * The text-attachment fork starts strictly after the last completed compaction,
 * so without this the fork of a compacted session loses everything the summary
 * retained — and when the compaction is the newest row it produced an empty
 * attachment. Reading the summary back out of the provider transcript keeps
 * that entirely inside the Claude provider: no protocol change, no new timeline
 * item type, nothing added to what every client has to understand.
 */

interface CompactTranscriptEntry {
  uuid?: unknown;
  type?: unknown;
  subtype?: unknown;
  isCompactSummary?: unknown;
  compactMetadata?: { preservedMessages?: { anchorUuid?: unknown } | null } | null;
  message?: { content?: unknown } | null;
}

function readEntries(content: string): CompactTranscriptEntry[] {
  const entries: CompactTranscriptEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        entries.push(parsed as CompactTranscriptEntry);
      }
    } catch {
      // A partially flushed final line is expected while a session is live.
    }
  }
  return entries;
}

/** Flatten a transcript message body to plain text. */
function readEntryText(entry: CompactTranscriptEntry): string | null {
  const content = entry.message?.content;
  if (typeof content === "string") {
    return content.trim() || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const value of content) {
    if (typeof value === "string") {
      parts.push(value);
      continue;
    }
    if (!value || typeof value !== "object") {
      continue;
    }
    const block = value as { type?: unknown; text?: unknown };
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n").trim() || null;
}

/**
 * The summary of the transcript's LAST completed compaction, or `null`.
 *
 * Anchored on the last `compact_boundary` rather than simply the last
 * `isCompactSummary` entry, so a session compacted twice cannot answer with the
 * older summary: the boundary names its own summary through
 * `compactMetadata.preservedMessages.anchorUuid`, and the scan after the
 * boundary is only the fallback for a transcript that omits the anchor.
 *
 * Returns `null` when the session was never compacted, when the boundary is the
 * very last thing in the file (the summary has not been written yet), or when
 * the summary is empty — callers must treat that as "no summary available" and
 * say the pre-compaction history was dropped, never that it was summarized.
 */
export function readClaudeCompactSummary(content: string | null | undefined): string | null {
  if (!content) {
    return null;
  }
  const entries = readEntries(content);
  const boundaryIndex = entries.findLastIndex(
    (entry) => entry.type === "system" && entry.subtype === "compact_boundary",
  );
  if (boundaryIndex < 0) {
    return null;
  }
  const anchorUuid = entries[boundaryIndex]?.compactMetadata?.preservedMessages?.anchorUuid;
  if (typeof anchorUuid === "string" && anchorUuid.length > 0) {
    const anchored = entries.find((entry) => entry.uuid === anchorUuid);
    if (anchored) {
      return readEntryText(anchored);
    }
  }
  for (let index = boundaryIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.isCompactSummary) {
      return readEntryText(entry);
    }
  }
  return null;
}
