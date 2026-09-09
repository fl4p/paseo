import { existsSync, promises as fsPromises } from "node:fs";
import type { Logger } from "pino";

import { writeFileAtomic } from "../../../atomic-file.js";
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
 * - a `compact_boundary` entry in the copied transcript carries the relink info
 *   that lets a resumed session rebuild the *compacted* context rather than
 *   re-inflating the pre-compaction history.
 *
 * The second one does not survive the copy on its own. `forkSession` remaps the
 * top-level `uuid` / `parentUuid` / `logicalParentUuid`, but the uuids buried in
 * `compactMetadata.preservedMessages` / `.preservedSegment` are copied verbatim,
 * so they still name *source* entries. The loader only applies the relink when
 * every preserved uuid resolves inside the transcript it is reading, so in a
 * fork it silently skips it and the resumed fork walks the pre-compaction chain
 * — the exact re-inflation this feature exists to prevent. Measured against
 * @anthropic-ai/claude-agent-sdk 0.3.246: a fork of a real compacted transcript
 * resolved 0 of its 5 preserved refs where the source resolved 5 of 5.
 *
 * `repairForkedCompactBoundaries` closes that gap after the fact: every forked
 * entry carries `forkedFrom.messageUuid` naming the source entry it was copied
 * from, which is exactly the source-uuid -> fork-uuid map the embedded refs
 * need.
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
 * Read/write seam over a forked session's transcript file, so the
 * compact-boundary repair below can be driven without a live provider.
 */
export interface ClaudeForkTranscriptStore {
  /** Raw JSONL of the session, or `null` when the file is unavailable. */
  read(sessionId: string): Promise<string | null> | string | null;
  /** Replace the session file. Implementations must write atomically. */
  write(sessionId: string, content: string): Promise<void>;
}

/** Outcome of rewriting the embedded compact-boundary uuids of one transcript. */
export interface ForkCompactRepairStats {
  /** `compact_boundary` entries carrying preserved-uuid references. */
  boundaries: number;
  /** References rewritten from a source uuid onto the matching fork uuid. */
  rewritten: number;
  /** References left alone because nothing in the fork mapped to them. */
  unresolved: number;
  /** References that already named a fork entry, so were left alone. */
  alreadyForked: number;
}

const EMPTY_REPAIR_STATS: ForkCompactRepairStats = {
  boundaries: 0,
  rewritten: 0,
  unresolved: 0,
  alreadyForked: 0,
};

interface ForkedEntry {
  uuid?: unknown;
  type?: unknown;
  subtype?: unknown;
  forkedFrom?: { messageUuid?: unknown } | null;
  compactMetadata?: unknown;
}

/** Uuid-bearing fields of `compactMetadata`, by container key. */
const COMPACT_UUID_FIELDS: Record<string, { scalars: string[]; lists: string[] }> = {
  preservedMessages: { scalars: ["anchorUuid"], lists: ["uuids", "allUuids"] },
  preservedSegment: { scalars: ["headUuid", "anchorUuid", "tailUuid"], lists: [] },
};

interface RepairContext {
  sourceToFork: ReadonlyMap<string, string>;
  forkUuids: ReadonlySet<string>;
  stats: ForkCompactRepairStats;
}

/**
 * Rewrite the source uuids embedded in a forked transcript's compact
 * boundaries onto the fork's own uuids.
 *
 * Pure and idempotent: a reference that already names a fork entry, or that
 * nothing in the fork maps to, is left exactly as it was — a stale relink still
 * loads, a half-rewritten one would corrupt the chain. Lines that need no
 * change are passed through byte for byte, so unknown fields and the trailing
 * partial line of a session being appended to survive untouched.
 */
export function repairForkedCompactBoundaries(content: string): {
  content: string;
  changed: boolean;
  stats: ForkCompactRepairStats;
} {
  const lines = content.split("\n");
  const parsed = lines.map((line) => parseRepairLine(line));
  const { sourceToFork, forkUuids } = indexForkedEntries(parsed);

  const stats = { ...EMPTY_REPAIR_STATS };
  let changed = false;
  const nextLines = lines.map((line, index) => {
    const entry = parsed[index];
    const metadata = entry ? readCompactMetadata(entry) : null;
    if (!entry || !metadata) {
      return line;
    }
    stats.boundaries += 1;
    if (!rewriteCompactMetadata(metadata, { sourceToFork, forkUuids, stats })) {
      return line;
    }
    changed = true;
    return JSON.stringify(entry);
  });

  return { content: changed ? nextLines.join("\n") : content, changed, stats };
}

function indexForkedEntries(entries: readonly (ForkedEntry | null)[]): {
  sourceToFork: Map<string, string>;
  forkUuids: Set<string>;
} {
  const sourceToFork = new Map<string, string>();
  const forkUuids = new Set<string>();
  for (const entry of entries) {
    const uuid = readString(entry?.uuid);
    if (!entry || !uuid) {
      continue;
    }
    forkUuids.add(uuid);
    const source = readString(entry.forkedFrom?.messageUuid);
    if (source) {
      sourceToFork.set(source, uuid);
    }
  }
  return { sourceToFork, forkUuids };
}

function parseRepairLine(line: string): ForkedEntry | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? (parsed as ForkedEntry) : null;
  } catch {
    // A partially flushed final line is expected; leave it alone.
    return null;
  }
}

function readCompactMetadata(entry: ForkedEntry): Record<string, unknown> | null {
  if (entry.type !== "system" || entry.subtype !== "compact_boundary") {
    return null;
  }
  const metadata = entry.compactMetadata;
  return metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : null;
}

function rewriteCompactMetadata(
  metadata: Record<string, unknown>,
  context: RepairContext,
): boolean {
  let changed = false;
  for (const [key, fields] of Object.entries(COMPACT_UUID_FIELDS)) {
    const container = metadata[key];
    if (!container || typeof container !== "object") {
      continue;
    }
    const record = container as Record<string, unknown>;
    for (const field of fields.scalars) {
      const next = mapRef(record[field], context);
      if (next !== null) {
        record[field] = next;
        changed = true;
      }
    }
    for (const field of fields.lists) {
      changed = rewriteUuidList(record[field], context) || changed;
    }
  }
  return changed;
}

function rewriteUuidList(list: unknown, context: RepairContext): boolean {
  if (!Array.isArray(list)) {
    return false;
  }
  let changed = false;
  for (let index = 0; index < list.length; index += 1) {
    const next = mapRef(list[index], context);
    if (next !== null) {
      list[index] = next;
      changed = true;
    }
  }
  return changed;
}

/** The fork uuid for `value`, or `null` when the reference must be left alone. */
function mapRef(value: unknown, context: RepairContext): string | null {
  const uuid = readString(value);
  if (!uuid) {
    return null;
  }
  if (context.forkUuids.has(uuid)) {
    // Already names an entry of this fork, so repairing twice is a no-op.
    context.stats.alreadyForked += 1;
    return null;
  }
  const mapped = context.sourceToFork.get(uuid);
  if (!mapped) {
    // Nothing in the fork was copied from that entry — most likely the fork was
    // sliced before it. Leaving the stale reference only costs the relink;
    // inventing one would corrupt the chain.
    context.stats.unresolved += 1;
    return null;
  }
  context.stats.rewritten += 1;
  return mapped;
}

/**
 * Apply `repairForkedCompactBoundaries` to a forked session file.
 *
 * Never throws: a fork whose relink is stale is still a usable fork, so a
 * failure here is logged and swallowed rather than failing the fork. Every
 * outcome is logged, so the situation stays observable either way.
 */
export async function repairForkedSessionCompaction(input: {
  sessionId: string;
  store?: ClaudeForkTranscriptStore | null;
  logger?: Logger | null;
}): Promise<{ repaired: boolean; stats: ForkCompactRepairStats }> {
  const failed = { repaired: false, stats: { ...EMPTY_REPAIR_STATS } };
  if (!input.store) {
    input.logger?.warn(
      { sessionId: input.sessionId },
      "claude.fork.compact_repair.unavailable: the forked transcript is not reachable",
    );
    return failed;
  }
  try {
    const content = await input.store.read(input.sessionId);
    if (!content) {
      input.logger?.warn(
        { sessionId: input.sessionId },
        "claude.fork.compact_repair.unreadable: the forked transcript could not be read",
      );
      return failed;
    }
    const repair = repairForkedCompactBoundaries(content);
    if (repair.changed) {
      await input.store.write(input.sessionId, repair.content);
    }
    input.logger?.info(
      { sessionId: input.sessionId, changed: repair.changed, ...repair.stats },
      "claude.fork.compact_repair.complete",
    );
    return { repaired: repair.changed, stats: repair.stats };
  } catch (error) {
    input.logger?.warn(
      { err: error, sessionId: input.sessionId },
      "claude.fork.compact_repair.failed: the fork keeps a stale compaction relink",
    );
    return failed;
  }
}

/**
 * Transcript store backed by the Claude project directory. `resolvePath`
 * answers with the session's `.jsonl` path, or `null` when it cannot be found.
 */
export function createClaudeForkTranscriptStore(
  resolvePath: (sessionId: string) => string | null,
): ClaudeForkTranscriptStore {
  return {
    read(sessionId) {
      const path = resolvePath(sessionId);
      if (!path || !existsSync(path)) {
        return null;
      }
      return fsPromises.readFile(path, "utf8");
    },
    async write(sessionId, content) {
      const path = resolvePath(sessionId);
      if (!path) {
        throw new Error(`Cannot locate the transcript of Claude session ${sessionId}`);
      }
      await writeFileAtomic(path, content);
    },
  };
}

/**
 * Fork the source Claude session, optionally truncated at `boundaryMessageId`.
 * `readTranscript` returns the raw JSONL of the source session, or `null` when
 * the file is unavailable; it is only consulted when a boundary is requested.
 *
 * `forkTranscript` is the seam the compact-boundary repair reads and writes
 * through. It is optional only so a caller that cannot reach the transcript
 * still gets its fork; the repair is then skipped and logged.
 */
export async function forkClaudeSession(input: {
  sdk: ClaudeRewindSdk;
  sessionId: string | null;
  boundaryMessageId?: string | null;
  readTranscript: () => Promise<string | null> | string | null;
  forkTranscript?: ClaudeForkTranscriptStore | null;
  logger?: Logger | null;
}): Promise<{ sessionId: string }> {
  if (!input.sessionId) {
    throw new Error("Claude session is not ready to fork");
  }
  const fork = await forkAtBoundary({ ...input, sessionId: input.sessionId });
  await repairForkedSessionCompaction({
    sessionId: fork.sessionId,
    store: input.forkTranscript,
    logger: input.logger,
  });
  return fork;
}

/**
 * Delete a session created by `forkClaudeSession`.
 *
 * The fork is irreversible at the provider level: once `forkSession` has
 * written the branch, a later failure (a missing workspace, a failed import,
 * a removed cwd) would otherwise leave an orphan transcript on disk that the
 * "recent provider sessions" list happily offers for import. Callers use this
 * to roll that back, best effort — the caller keeps and reports the ORIGINAL
 * error, so this one is returned rather than thrown.
 *
 * Refuses to touch anything other than the fork it was handed, so a mistake in
 * the caller cannot delete the source session.
 */
export async function deleteForkedClaudeSession(input: {
  sdk: ClaudeRewindSdk;
  forkSessionId: string;
  sourceSessionId: string | null;
}): Promise<void> {
  const forkSessionId = input.forkSessionId.trim();
  if (!forkSessionId) {
    throw new Error("Cannot delete a forked Claude session without its id");
  }
  if (forkSessionId === input.sourceSessionId?.trim()) {
    throw new Error(`Refusing to delete the source Claude session ${forkSessionId}`);
  }
  await input.sdk.deleteSession(forkSessionId);
}

async function forkAtBoundary(input: {
  sdk: ClaudeRewindSdk;
  sessionId: string;
  boundaryMessageId?: string | null;
  readTranscript: () => Promise<string | null> | string | null;
}): Promise<{ sessionId: string }> {
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
