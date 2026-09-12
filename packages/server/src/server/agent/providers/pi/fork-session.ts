import { existsSync, promises as fsPromises } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Logger } from "pino";

import { writeFileAtomic } from "../../../atomic-file.js";

/**
 * Provider-native fork for Pi.
 *
 * `forkPiSession` branches a Pi session's JSONL file, copying the retained
 * branch from root to the cut point. In Pi, entries link via `id` and `parentId`.
 *
 * By retaining the exact entry IDs, message content, tool calls, and tool results,
 * the forked session reconstructs the exact same message prefix as the source.
 * This guarantees:
 * - 100% KV-cache reuse with the model provider;
 * - Any compactions on the branched path are preserved;
 * - The new session starts with warm cache rather than paying to re-expand history.
 */

export interface PiTranscriptHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp?: string;
  cwd: string;
  parentSession?: string;
  [key: string]: unknown;
}

export interface PiTranscriptEntry {
  type: string;
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  message?: {
    role?: unknown;
    id?: unknown;
    stopReason?: unknown;
    content?: unknown;
    toolCallId?: unknown;
    toolName?: unknown;
    isError?: unknown;
    errorMessage?: unknown;
    responseId?: unknown;
    [key: string]: unknown;
  } | null;
  summary?: unknown;
  tokensBefore?: unknown;
  [key: string]: unknown;
}

export class PiForkBoundaryError extends Error {
  constructor(messageId: string) {
    super(`Cannot fork: message ${messageId} is not in the Pi transcript`);
    this.name = "PiForkBoundaryError";
  }
}

export class PiForkInFlightError extends Error {
  constructor(reason: string) {
    super(`Cannot fork while a turn is in flight: ${reason}`);
    this.name = "PiForkInFlightError";
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Parse a Pi session JSONL transcript into typed entries.
 * Skips non-JSON / truncated lines (normal for a live session being appended to).
 */
export function parsePiTranscriptEntries(content: string): PiTranscriptEntry[] {
  const entries: PiTranscriptEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        entries.push(parsed as PiTranscriptEntry);
      }
    } catch {
      // Partially flushed trailing lines are expected for a live session.
    }
  }
  return entries;
}

/**
 * Map a Paseo timeline message ID onto the entry ID in the Pi transcript.
 * Checks entry.id, entry.message.id, and toolResult toolCallId.
 */
export function resolveForkBoundaryEntryId(
  entries: readonly PiTranscriptEntry[],
  messageId: string,
): string | null {
  const wanted = messageId.trim();
  if (!wanted) {
    return null;
  }
  let fallbackMatch: string | null = null;
  for (const entry of entries) {
    const id = readString(entry.id);
    if (!id) {
      continue;
    }
    if (id === wanted) {
      return id;
    }
    if (readString(entry.message?.id) === wanted) {
      fallbackMatch = id;
    } else if (readString(entry.message?.responseId) === wanted) {
      fallbackMatch = id;
    } else if (
      entry.message?.role === "toolResult" &&
      readString(entry.message?.toolCallId) === wanted
    ) {
      fallbackMatch = id;
    }
  }
  return fallbackMatch;
}

const PI_TURN_ENDING_STOP_REASONS = new Set(["stop", "length", "error", "aborted"]);

export function endsPiAssistantTurn(entry: PiTranscriptEntry): boolean {
  if (entry.type !== "message" || entry.message?.role !== "assistant") {
    return false;
  }
  const stopReason = readString(entry.message?.stopReason)?.toLowerCase();
  return Boolean(stopReason && PI_TURN_ENDING_STOP_REASONS.has(stopReason));
}

function extractToolCallId(block: unknown): string | null {
  if (!block || typeof block !== "object") {
    return null;
  }
  const rec = block as Record<string, unknown>;
  return rec.type === "toolCall" ? readString(rec.id) : null;
}

export function readPiToolBlockIds(entry: PiTranscriptEntry): {
  opened: string[];
  closed: string[];
} {
  const opened: string[] = [];
  const closed: string[] = [];
  if (entry.type !== "message" || !entry.message) {
    return { opened, closed };
  }
  if (entry.message.role === "assistant" && Array.isArray(entry.message.content)) {
    for (const block of entry.message.content) {
      const id = extractToolCallId(block);
      if (id) opened.push(id);
    }
  } else if (entry.message.role === "toolResult") {
    const id = readString(entry.message.toolCallId);
    if (id) closed.push(id);
  }
  return { opened, closed };
}

function indexTranscriptEntries(entries: readonly PiTranscriptEntry[]): {
  entriesById: Map<string, PiTranscriptEntry>;
  idBearingEntries: PiTranscriptEntry[];
} {
  const entriesById = new Map<string, PiTranscriptEntry>();
  const idBearingEntries: PiTranscriptEntry[] = [];
  for (const entry of entries) {
    const id = readString(entry.id);
    if (id && entry.type !== "session") {
      entriesById.set(id, entry);
      idBearingEntries.push(entry);
    }
  }
  return { entriesById, idBearingEntries };
}

function buildBranchPath(
  targetEntry: PiTranscriptEntry,
  entriesById: Map<string, PiTranscriptEntry>,
): PiTranscriptEntry[] {
  const pathEntries: PiTranscriptEntry[] = [];
  const visited = new Set<string>();
  let curr: PiTranscriptEntry | undefined = targetEntry;
  while (curr) {
    const currId = readString(curr.id);
    if (!currId || visited.has(currId)) break;
    visited.add(currId);
    pathEntries.push(curr);
    const parentId = readString(curr.parentId);
    curr = parentId ? entriesById.get(parentId) : undefined;
  }
  return pathEntries.toReversed();
}

/**
 * Find the safest entry to cut at.
 *
 * Invariant 1: Tool call pairing. Never cut where an opened toolCall has no
 * toolResult yet. If the requested boundary has open tool calls, walks backward
 * along the branch to the nearest point where all tool calls were closed.
 *
 * Invariant 2: Completed turn. When requireTurnEnd is true (turn in flight
 * and no explicit boundary picked), the cut must land on a completed assistant
 * turn (stopReason is terminal: "stop", "length", "error", or "aborted").
 */
export function resolveSafePiForkEntry(
  entries: readonly PiTranscriptEntry[],
  options: { boundaryMessageId?: string | null; requireTurnEnd?: boolean } = {},
): { entryId: string; entry: PiTranscriptEntry } | null {
  const boundaryId = options.boundaryMessageId?.trim() || null;
  const targetId = boundaryId ? resolveForkBoundaryEntryId(entries, boundaryId) : null;
  if (boundaryId && !targetId) {
    return null;
  }

  const { entriesById, idBearingEntries } = indexTranscriptEntries(entries);
  if (idBearingEntries.length === 0) {
    return null;
  }

  const targetEntry = targetId
    ? entriesById.get(targetId)
    : idBearingEntries[idBearingEntries.length - 1];

  if (!targetEntry) {
    return null;
  }

  const pathEntries = buildBranchPath(targetEntry, entriesById);
  const open = new Set<string>();
  let safeCandidate: PiTranscriptEntry | null = null;

  for (const entry of pathEntries) {
    const { opened, closed } = readPiToolBlockIds(entry);
    for (const id of closed) open.delete(id);
    for (const id of opened) open.add(id);

    const endsTurn = endsPiAssistantTurn(entry);
    const isSafe = open.size === 0 && (!options.requireTurnEnd || endsTurn);
    if (isSafe) {
      safeCandidate = entry;
    }
  }

  const safeId = safeCandidate ? readString(safeCandidate.id) : null;
  return safeCandidate && safeId ? { entryId: safeId, entry: safeCandidate } : null;
}

function extractSessionHeader(entries: readonly PiTranscriptEntry[]): PiTranscriptEntry & {
  type: "session";
  cwd?: string;
  id?: string;
  version?: number;
} {
  const header = entries.find(
    (
      e,
    ): e is PiTranscriptEntry & { type: "session"; cwd?: string; id?: string; version?: number } =>
      e.type === "session",
  );
  if (!header) {
    throw new Error("Invalid Pi session transcript: missing session header");
  }
  return header;
}

function serializeForkTranscript(
  header: PiTranscriptEntry & { type: "session"; cwd?: string; id?: string; version?: number },
  branch: readonly PiTranscriptEntry[],
  options: { newSessionId: string; timestamp: Date; sourceSessionPath: string },
): string {
  const sourceCwd = typeof header.cwd === "string" ? header.cwd : process.cwd();
  const newHeader: PiTranscriptHeader = {
    type: "session",
    version: typeof header.version === "number" ? header.version : 3,
    id: options.newSessionId,
    timestamp: options.timestamp.toISOString(),
    cwd: sourceCwd,
    parentSession: options.sourceSessionPath,
  };

  const lines: string[] = [JSON.stringify(newHeader)];
  for (const entry of branch) {
    lines.push(JSON.stringify(entry));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Branch the source Pi session file into a new session file.
 */
export async function forkPiSession(options: {
  sourceSessionPath: string;
  boundaryMessageId?: string | null;
  atCompletedTurn?: boolean;
  newSessionId?: string;
  timestamp?: Date;
  sessionDir?: string;
  logger?: Logger;
}): Promise<{ sessionId: string; sessionPath: string }> {
  if (!existsSync(options.sourceSessionPath)) {
    throw new Error(`Cannot locate the transcript of Pi session at ${options.sourceSessionPath}`);
  }

  const content = await fsPromises.readFile(options.sourceSessionPath, "utf8");
  const entries = parsePiTranscriptEntries(content);
  const header = extractSessionHeader(entries);

  const boundary = options.boundaryMessageId?.trim() || null;
  const requested = boundary ? resolveForkBoundaryEntryId(entries, boundary) : null;
  if (boundary && !requested) {
    throw new PiForkBoundaryError(boundary);
  }

  const safeResult = resolveSafePiForkEntry(entries, {
    boundaryMessageId: requested,
    requireTurnEnd: options.atCompletedTurn && !requested,
  });

  if (!safeResult) {
    if (boundary) throw new PiForkBoundaryError(boundary);
    if (options.atCompletedTurn) throw new PiForkInFlightError("no turn has completed yet");
    throw new Error("Cannot fork: no safe position found in transcript");
  }

  if (requested && safeResult.entryId !== requested) {
    options.logger?.info(
      {
        sourceSessionPath: options.sourceSessionPath,
        requestedId: requested,
        forkId: safeResult.entryId,
        atCompletedTurn: options.atCompletedTurn === true,
      },
      "pi.fork.trimmed_to_complete_position",
    );
  }

  const { entriesById } = indexTranscriptEntries(entries);
  const branch = buildBranchPath(safeResult.entry, entriesById);

  const newSessionId = options.newSessionId ?? randomUUID();
  const timestamp = options.timestamp ?? new Date();
  const fileTimestamp = timestamp.toISOString().replace(/[:.]/g, "-");
  const sessionDir = options.sessionDir ?? path.dirname(options.sourceSessionPath);
  const sessionPath = path.join(sessionDir, `${fileTimestamp}_${newSessionId}.jsonl`);

  const fileContent = serializeForkTranscript(header, branch, {
    newSessionId,
    timestamp,
    sourceSessionPath: options.sourceSessionPath,
  });

  await writeFileAtomic(sessionPath, fileContent);

  options.logger?.info(
    {
      sourceSessionPath: options.sourceSessionPath,
      sessionPath,
      sessionId: newSessionId,
      entryCount: branch.length,
    },
    "pi.fork.created",
  );

  return { sessionId: newSessionId, sessionPath };
}

/**
 * Read the compaction summary from a Pi transcript at or before `untilMessageId`.
 */
export function readPiCompactionSummary(
  content: string | null | undefined,
  options?: { untilMessageId?: string | null },
): string | null {
  if (!content) {
    return null;
  }
  const entries = parsePiTranscriptEntries(content);
  const until = options?.untilMessageId?.trim() || null;
  let endIndex = entries.length - 1;
  if (until) {
    const targetEntryId = resolveForkBoundaryEntryId(entries, until);
    if (!targetEntryId) {
      return null;
    }
    endIndex = entries.findIndex((e) => readString(e.id) === targetEntryId);
    if (endIndex < 0) {
      return null;
    }
  }

  for (let index = endIndex; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "compaction") {
      const summary =
        readString(entry.summary) ??
        readString(entry.message?.content) ??
        (entry.message && typeof entry.message === "object"
          ? readString((entry.message as Record<string, unknown>).summary)
          : null);
      if (summary) {
        return summary;
      }
    }
  }
  return null;
}

/**
 * Delete a session file created by `forkPiSession` on rollback.
 */
export async function deleteForkedPiSession(options: {
  sourceSessionPath: string;
  forkSessionPath: string;
}): Promise<void> {
  const forkPath = path.resolve(options.forkSessionPath.trim());
  const sourcePath = path.resolve(options.sourceSessionPath.trim());
  if (!forkPath) {
    throw new Error("Cannot delete a forked Pi session without its path");
  }
  if (forkPath === sourcePath) {
    throw new Error(`Refusing to delete the source Pi session ${forkPath}`);
  }
  if (existsSync(forkPath)) {
    await fsPromises.unlink(forkPath);
  }
}
