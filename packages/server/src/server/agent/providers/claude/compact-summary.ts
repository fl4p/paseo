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
  message?: { id?: unknown; content?: unknown } | null;
}

function isCompactBoundary(entry: CompactTranscriptEntry | undefined): boolean {
  return entry?.type === "system" && entry.subtype === "compact_boundary";
}

/**
 * Index of the entry a paseo message id names, or -1.
 *
 * Accepts both spellings a timeline item can carry, the same way the fork
 * boundary resolver does: history-loaded items use the transcript `uuid`, live
 * streamed assistant messages use the Anthropic `msg_…` id. A uuid hit wins,
 * because one API message can span several entries and the LAST of them is the
 * position meant.
 */
function findEntryIndexForMessageId(
  entries: readonly CompactTranscriptEntry[],
  messageId: string,
): number {
  let apiMatch = -1;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.uuid === messageId) {
      return index;
    }
    if (entry?.message?.id === messageId) {
      apiMatch = index;
    }
  }
  return apiMatch;
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
 * The summary of the last completed compaction at or before `untilMessageId`,
 * or `null`.
 *
 * Anchored on a `compact_boundary` rather than simply the last
 * `isCompactSummary` entry, so a session compacted twice cannot answer with the
 * wrong summary: the boundary names its own summary through
 * `compactMetadata.preservedMessages.anchorUuid`, and the scan after the
 * boundary is only the fallback for a transcript that omits the anchor. That
 * scan stops at the NEXT boundary, so a compaction whose summary is missing
 * cannot borrow a later one's.
 *
 * `untilMessageId` is the fork point. Without it a bounded fork inherits
 * whatever the session compacted LAST, which for `A -> fork point -> B` means
 * carrying B's summary — content from after the fork point, describing turns
 * the fork does not contain. With it, only compactions at or before the fork
 * point are eligible. A message id that is not in the transcript answers
 * `null` rather than falling back to the unbounded read, because an unbounded
 * read is exactly the leak.
 *
 * Returns `null` when the session was never compacted before that point, when
 * the boundary is the very last thing in the file (the summary has not been
 * written yet), or when the summary is empty — callers must treat that as "no
 * summary available" and say the pre-compaction history was dropped, never
 * that it was summarized.
 */
export function readClaudeCompactSummary(
  content: string | null | undefined,
  options?: { untilMessageId?: string | null },
): string | null {
  if (!content) {
    return null;
  }
  const entries = readEntries(content);
  const until = options?.untilMessageId?.trim() || null;
  let endIndex = entries.length - 1;
  if (until) {
    endIndex = findEntryIndexForMessageId(entries, until);
    if (endIndex < 0) {
      return null;
    }
  }
  let boundaryIndex = -1;
  for (let index = endIndex; index >= 0; index -= 1) {
    if (isCompactBoundary(entries[index])) {
      boundaryIndex = index;
      break;
    }
  }
  if (boundaryIndex < 0) {
    return null;
  }
  return readBoundarySummary(entries, boundaryIndex);
}

function readBoundarySummary(
  entries: readonly CompactTranscriptEntry[],
  boundaryIndex: number,
): string | null {
  const anchorUuid = entries[boundaryIndex]?.compactMetadata?.preservedMessages?.anchorUuid;
  if (typeof anchorUuid === "string" && anchorUuid.length > 0) {
    const anchored = entries.find((entry) => entry.uuid === anchorUuid);
    if (anchored) {
      return readEntryText(anchored);
    }
  }
  // Fallback for a transcript with no anchor. Stops at the next boundary: a
  // compaction whose own summary is missing must answer `null`, not borrow the
  // summary of a later one.
  for (let index = boundaryIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (isCompactBoundary(entry)) {
      return null;
    }
    if (entry?.isCompactSummary) {
      return readEntryText(entry);
    }
  }
  return null;
}
