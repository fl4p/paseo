import type { ClaudeRewindSdk } from "./rewind.js";

/**
 * Provider-native fork for Claude.
 *
 * `forkSession` copies the transcript into a new session file, remapping every
 * message UUID and preserving the `parentUuid` chain, so the fork replays the
 * same message prefix as the source. Two consequences we care about:
 *
 * - the prompt cache is a prefix match over `tools -> system -> messages`, so a
 *   fork that reuses the prefix keeps hitting it, while a synthetic first user
 *   message never can;
 * - a `compact_boundary` entry in the copied transcript still carries its
 *   relink info, so a resumed fork rebuilds the *compacted* context rather than
 *   re-inflating the pre-compaction history.
 *
 * `upToMessageId` is a **transcript UUID**, not the Anthropic API `msg_…` id.
 * Paseo timeline items carry either one depending on where they came from:
 * history-loaded entries use `entry.uuid` (a transcript UUID), while live
 * streamed assistant messages use the API message id. `resolveForkBoundaryUuid`
 * accepts both and always answers with a transcript UUID.
 */

export interface ClaudeForkBoundaryEntry {
  uuid?: unknown;
  message?: { id?: unknown } | null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Parse a Claude transcript (JSONL) into the id-bearing fields we need. Lines
 * that are not JSON objects are skipped: a truncated tail is normal for a live
 * session being appended to while we read it.
 */
export function parseTranscriptBoundaryEntries(content: string): ClaudeForkBoundaryEntry[] {
  const entries: ClaudeForkBoundaryEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        entries.push(parsed as ClaudeForkBoundaryEntry);
      }
    } catch {
      // A partially flushed final line is expected; ignore it.
    }
  }
  return entries;
}

/**
 * Map a paseo timeline message id onto the transcript UUID `forkSession`
 * expects. Returns `null` when the transcript does not contain the message —
 * callers must treat that as "cannot fork at this boundary" rather than
 * silently forking the whole session, which would defeat the boundary.
 */
export function resolveForkBoundaryUuid(
  entries: readonly ClaudeForkBoundaryEntry[],
  messageId: string,
): string | null {
  const wanted = messageId.trim();
  if (!wanted) {
    return null;
  }
  // Prefer a direct uuid hit; only fall back to the API message id, because one
  // API message can span several transcript entries and we want the last of
  // them (the boundary is inclusive).
  let apiMatch: string | null = null;
  for (const entry of entries) {
    const uuid = readString(entry.uuid);
    if (!uuid) {
      continue;
    }
    if (uuid === wanted) {
      return uuid;
    }
    if (readString(entry.message?.id) === wanted) {
      apiMatch = uuid;
    }
  }
  return apiMatch;
}

export class ClaudeForkBoundaryError extends Error {
  constructor(messageId: string) {
    super(`Cannot fork: message ${messageId} is not in the Claude transcript`);
    this.name = "ClaudeForkBoundaryError";
  }
}

/**
 * Fork the source Claude session, optionally truncated at `boundaryMessageId`.
 * `readTranscript` returns the raw JSONL of the source session, or `null` when
 * the file is unavailable; it is only consulted when a boundary is requested.
 */
export async function forkClaudeSession(input: {
  sdk: ClaudeRewindSdk;
  sessionId: string | null;
  boundaryMessageId?: string | null;
  readTranscript: () => Promise<string | null> | string | null;
}): Promise<{ sessionId: string }> {
  if (!input.sessionId) {
    throw new Error("Claude session is not ready to fork");
  }
  const boundary = input.boundaryMessageId?.trim() || null;
  if (!boundary) {
    return await input.sdk.forkSession(input.sessionId, {});
  }
  const content = await input.readTranscript();
  if (!content) {
    throw new ClaudeForkBoundaryError(boundary);
  }
  const uuid = resolveForkBoundaryUuid(parseTranscriptBoundaryEntries(content), boundary);
  if (!uuid) {
    throw new ClaudeForkBoundaryError(boundary);
  }
  return await input.sdk.forkSession(input.sessionId, { upToMessageId: uuid });
}
