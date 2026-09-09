import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pino from "pino";
import {
  createClaudeForkTranscriptStore,
  forkClaudeSession,
  repairForkedCompactBoundaries,
} from "./fork-session.js";
import { realClaudeRewindSdk } from "./rewind.js";

/**
 * These tests drive the REAL `forkSession` from @anthropic-ai/claude-agent-sdk
 * against a hermetic `CLAUDE_CONFIG_DIR`, because the defect they cover is a
 * property of the SDK's copy (it remaps top-level uuids but not the ones nested
 * in `compactMetadata`). A hand-written fake would only prove that the repair
 * undoes the fake. Nothing here talks to the network or spawns the CLI.
 */

const logger = pino({ level: "silent" });

interface TranscriptEntry {
  uuid: string;
  parentUuid: string | null;
  type: string;
  subtype?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  teamName?: string;
  logicalParentUuid?: string | null;
  compactMetadata?: {
    preservedMessages?: { anchorUuid: string; uuids: string[]; allUuids: string[] };
    preservedSegment?: { headUuid: string; anchorUuid: string; tailUuid: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

/**
 * A compacted transcript in the shape the CLI writes: pre-compaction history,
 * a preserved tail, a `compact_boundary` whose `compactMetadata` names the
 * preserved entries, the compact summary, then post-compaction turns.
 */
function buildSourceTranscript(sessionId: string, cwd: string): TranscriptEntry[] {
  let counter = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
  const entries: TranscriptEntry[] = [];
  let parentUuid: string | null = null;
  const push = (entry: Partial<TranscriptEntry> & { type: string }): TranscriptEntry => {
    const full = {
      sessionId,
      cwd,
      version: "2.1.250",
      userType: "external",
      isSidechain: false,
      timestamp: new Date(1_700_000_000_000 + counter * 1000).toISOString(),
      uuid: uuid(),
      parentUuid,
      ...entry,
    } as TranscriptEntry;
    entries.push(full);
    parentUuid = full.uuid;
    return full;
  };

  for (let index = 0; index < 4; index += 1) {
    push({ type: "user", message: { role: "user", content: `old question ${index}` } });
    push({
      type: "assistant",
      message: {
        id: `msg_old_${index}`,
        role: "assistant",
        model: "claude",
        content: [{ type: "text", text: `old answer ${index}` }],
      },
    });
  }

  const preserved = [
    push({
      type: "assistant",
      message: {
        id: "msg_pres_1",
        role: "assistant",
        model: "claude",
        content: [{ type: "text", text: "preserved answer" }],
      },
    }),
    push({ type: "user", message: { role: "user", content: "preserved question" } }),
    push({ type: "user", message: { role: "user", content: "preserved follow-up" } }),
  ];

  const boundary: TranscriptEntry = {
    sessionId,
    cwd,
    version: "2.1.250",
    userType: "external",
    isSidechain: false,
    timestamp: new Date(1_700_000_000_000 + ++counter * 1000).toISOString(),
    uuid: uuid(),
    parentUuid: null,
    logicalParentUuid: preserved[preserved.length - 1]!.uuid,
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    level: "info",
    compactMetadata: {
      trigger: "auto",
      preTokens: 190_000,
      postTokens: 12_000,
      // Filled in below: the anchor is the compact summary, which does not
      // exist yet at this point in the file.
      preservedMessages: { anchorUuid: "", uuids: [], allUuids: [] },
      preservedSegment: { headUuid: "", anchorUuid: "", tailUuid: "" },
    },
  };
  entries.push(boundary);
  parentUuid = boundary.uuid;

  const summary = push({
    type: "user",
    isCompactSummary: true,
    message: { role: "user", content: "This session is being continued from a previous one." },
  });
  const preservedUuids = preserved.map((entry) => entry.uuid);
  boundary.compactMetadata!.preservedMessages = {
    anchorUuid: summary.uuid,
    uuids: preservedUuids,
    allUuids: preservedUuids,
  };
  boundary.compactMetadata!.preservedSegment = {
    headUuid: preservedUuids[0]!,
    anchorUuid: summary.uuid,
    tailUuid: preservedUuids[preservedUuids.length - 1]!,
  };

  push({ type: "user", message: { role: "user", content: "new question" } });
  push({
    type: "assistant",
    message: {
      id: "msg_new_1",
      role: "assistant",
      model: "claude",
      content: [{ type: "text", text: "new answer" }],
    },
  });
  return entries;
}

function parseTranscript(content: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    const parsed = JSON.parse(trimmed) as TranscriptEntry;
    const kind = parsed.type;
    if (
      typeof parsed.uuid === "string" &&
      (kind === "user" ||
        kind === "assistant" ||
        kind === "progress" ||
        kind === "system" ||
        kind === "attachment")
    ) {
      entries.push(parsed);
    }
  }
  return entries;
}

function boundaryRefs(entries: readonly TranscriptEntry[]): string[] {
  const refs: string[] = [];
  for (const entry of entries) {
    const meta = entry.compactMetadata;
    if (entry.subtype !== "compact_boundary" || !meta) {
      continue;
    }
    if (meta.preservedMessages) {
      refs.push(meta.preservedMessages.anchorUuid, ...meta.preservedMessages.uuids);
    }
    if (meta.preservedSegment) {
      refs.push(
        meta.preservedSegment.headUuid,
        meta.preservedSegment.anchorUuid,
        meta.preservedSegment.tailUuid,
      );
    }
  }
  return refs;
}

/**
 * Reimplementation of the loader's relink + chain walk (sdk.mjs, the function
 * that builds the resumed context). Skipping the relink is exactly what a
 * missing repair causes, so the chain this returns is what the resumed session
 * would actually replay.
 */
function reconstructChain(content: string): string[] {
  const entries = parseTranscript(content);
  const byUuid = new Map<string, TranscriptEntry>();
  for (const entry of entries) {
    byUuid.set(entry.uuid, entry);
  }
  for (const entry of byUuid.values()) {
    applyCompactRelink(byUuid, entry);
  }
  const newest = pickNewestConversational(byUuid, entries);
  return newest ? walkParents(byUuid, newest) : [];
}

function applyCompactRelink(byUuid: Map<string, TranscriptEntry>, entry: TranscriptEntry): void {
  if (entry.type !== "system" || entry.subtype !== "compact_boundary") {
    return;
  }
  const preserved = entry.compactMetadata?.preservedMessages;
  const segment = entry.compactMetadata?.preservedSegment;
  if (preserved) {
    if (preserved.uuids.length === 0 || preserved.uuids.some((id) => !byUuid.has(id))) {
      return;
    }
    let previous = preserved.anchorUuid;
    for (const id of preserved.uuids) {
      byUuid.set(id, { ...byUuid.get(id)!, parentUuid: previous });
      previous = id;
    }
    reparentChildren(byUuid, {
      anchorUuid: preserved.anchorUuid,
      keepUuid: preserved.uuids[0]!,
      newParentUuid: preserved.uuids[preserved.uuids.length - 1]!,
    });
    return;
  }
  if (segment) {
    const head = byUuid.get(segment.headUuid);
    if (head) {
      byUuid.set(segment.headUuid, { ...head, parentUuid: segment.anchorUuid });
    }
    reparentChildren(byUuid, {
      anchorUuid: segment.anchorUuid,
      keepUuid: segment.headUuid,
      newParentUuid: segment.tailUuid,
    });
  }
}

function reparentChildren(
  byUuid: Map<string, TranscriptEntry>,
  input: { anchorUuid: string; keepUuid: string; newParentUuid: string },
): void {
  for (const [id, value] of byUuid) {
    if (value.parentUuid === input.anchorUuid && id !== input.keepUuid) {
      byUuid.set(id, { ...value, parentUuid: input.newParentUuid });
    }
  }
}

function pickNewestConversational(
  byUuid: ReadonlyMap<string, TranscriptEntry>,
  entries: readonly TranscriptEntry[],
): TranscriptEntry | null {
  const order = new Map(entries.map((entry, index) => [entry.uuid, index]));
  const parents = new Set<string>();
  for (const entry of byUuid.values()) {
    if (entry.parentUuid) {
      parents.add(entry.parentUuid);
    }
  }
  const conversational: TranscriptEntry[] = [];
  for (const leaf of byUuid.values()) {
    if (parents.has(leaf.uuid)) {
      continue;
    }
    const found = walkToConversational(byUuid, leaf);
    if (found) {
      conversational.push(found);
    }
  }
  if (conversational.length === 0) {
    return null;
  }
  const preferred = conversational.filter(
    (entry) => !entry.isSidechain && !entry.teamName && !entry.isMeta,
  );
  const pool = preferred.length > 0 ? preferred : conversational;
  return pool.reduce((best, entry) =>
    (order.get(entry.uuid) ?? -1) > (order.get(best.uuid) ?? -1) ? entry : best,
  );
}

function walkToConversational(
  byUuid: ReadonlyMap<string, TranscriptEntry>,
  leaf: TranscriptEntry,
): TranscriptEntry | null {
  let cursor: TranscriptEntry | undefined = leaf;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.uuid)) {
    seen.add(cursor.uuid);
    if (cursor.type === "user" || cursor.type === "assistant") {
      return cursor;
    }
    cursor = cursor.parentUuid ? byUuid.get(cursor.parentUuid) : undefined;
  }
  return null;
}

function walkParents(
  byUuid: ReadonlyMap<string, TranscriptEntry>,
  newest: TranscriptEntry,
): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor: TranscriptEntry | undefined = byUuid.get(newest.uuid);
  while (cursor && !seen.has(cursor.uuid)) {
    seen.add(cursor.uuid);
    chain.push(cursor.uuid);
    cursor = cursor.parentUuid ? byUuid.get(cursor.parentUuid) : undefined;
  }
  return chain.toReversed();
}

describe("forked compact boundaries", () => {
  let root: string;
  let projectDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "paseo-fork-compaction-")));
    const cwd = join(root, "wd");
    mkdirSync(cwd, { recursive: true });
    projectDir = join(root, "cfg", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, `${SESSION_ID}.jsonl`),
      `${buildSourceTranscript(SESSION_ID, cwd)
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
      "utf8",
    );
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(root, "cfg");
  });

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const transcriptPath = (sessionId: string) => join(projectDir, `${sessionId}.jsonl`);
  const readTranscriptFile = (sessionId: string) => readFileSync(transcriptPath(sessionId), "utf8");
  const store = () => createClaudeForkTranscriptStore((sessionId) => transcriptPath(sessionId));

  it("keeps the compaction relink alive in the fork, so the replayed chain matches the source", async () => {
    const source = readTranscriptFile(SESSION_ID);
    const sourceChain = reconstructChain(source);
    // Sanity: the source's own relink resolves, otherwise the comparison below
    // would be measuring nothing.
    const sourceEntries = parseTranscript(source);
    const sourceUuids = new Set(sourceEntries.map((entry) => entry.uuid));
    expect(boundaryRefs(sourceEntries).every((ref) => sourceUuids.has(ref))).toBe(true);

    const fork = await forkClaudeSession({
      sdk: realClaudeRewindSdk,
      sessionId: SESSION_ID,
      readTranscript: () => source,
      forkTranscript: store(),
      logger,
    });

    const forked = readTranscriptFile(fork.sessionId);
    const forkedEntries = parseTranscript(forked);
    const forkedUuids = new Set(forkedEntries.map((entry) => entry.uuid));
    const refs = boundaryRefs(forkedEntries);
    expect(refs.length).toBeGreaterThan(0);
    // Every preserved reference names an entry of the FORK, not the source.
    expect(refs.filter((ref) => !forkedUuids.has(ref))).toEqual([]);
    expect(refs.some((ref) => sourceUuids.has(ref))).toBe(false);

    // The chain the loader would replay is the same size as the source's.
    // Without the repair the loader skips the relink and replays a different
    // chain (measured on this fixture: 4 entries instead of 7; on the real
    // transcripts that motivated this fix it went the other way and ballooned).
    expect(reconstructChain(forked)).toHaveLength(sourceChain.length);
  });

  it("forks a fork: an unbounded fork of a fork is a fork the SDK accepts", async () => {
    // `forkSession` appends a uuid-bearing `custom-title` entry to every fork
    // it writes, and its own transcript reader does NOT count `custom-title` as
    // a message. An unbounded fork of a fork used to pick that title uuid as
    // its cut and the SDK answered `Message ... not found in session ...`, so
    // forking a fork was broken outright.
    const first = await forkClaudeSession({
      sdk: realClaudeRewindSdk,
      sessionId: SESSION_ID,
      readTranscript: () => readTranscriptFile(SESSION_ID),
      forkTranscript: store(),
      logger,
    });
    const firstContent = readTranscriptFile(first.sessionId);
    // Precondition: the fork really does end with a uuid-bearing title entry.
    const lastEntry = firstContent
      .split("\n")
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line) as TranscriptEntry)
      .at(-1);
    expect(lastEntry?.type).toBe("custom-title");
    expect(typeof lastEntry?.uuid).toBe("string");

    const second = await forkClaudeSession({
      sdk: realClaudeRewindSdk,
      sessionId: first.sessionId,
      readTranscript: () => readTranscriptFile(first.sessionId),
      forkTranscript: store(),
      logger,
    });

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.sessionId).not.toBe(SESSION_ID);
    // The fork of the fork carries the conversation, not just a title.
    const forkedTypes = parseTranscript(readTranscriptFile(second.sessionId)).map(
      (entry) => entry.type,
    );
    expect(forkedTypes).toContain("assistant");
    expect(forkedTypes).toContain("user");
  });

  it("is idempotent: repairing an already repaired fork changes nothing", async () => {
    const fork = await forkClaudeSession({
      sdk: realClaudeRewindSdk,
      sessionId: SESSION_ID,
      readTranscript: () => readTranscriptFile(SESSION_ID),
      forkTranscript: store(),
      logger,
    });
    const repaired = readTranscriptFile(fork.sessionId);
    const again = repairForkedCompactBoundaries(repaired);
    expect(again.changed).toBe(false);
    expect(again.content).toBe(repaired);
    expect(again.stats.rewritten).toBe(0);
    expect(again.stats.unresolved).toBe(0);
    expect(again.stats.alreadyForked).toBeGreaterThan(0);
  });

  it("still returns the fork when the transcript cannot be repaired", async () => {
    const fork = await forkClaudeSession({
      sdk: realClaudeRewindSdk,
      sessionId: SESSION_ID,
      readTranscript: () => readTranscriptFile(SESSION_ID),
      forkTranscript: {
        read: () => {
          throw new Error("transcript store is down");
        },
        write: async () => {},
      },
      logger,
    });
    expect(fork.sessionId).not.toBe(SESSION_ID);
    // Stale relink, but a fork all the same.
    const refs = boundaryRefs(parseTranscript(readTranscriptFile(fork.sessionId)));
    expect(refs.length).toBeGreaterThan(0);
  });
});

describe("repairForkedCompactBoundaries", () => {
  const forkedLine = (entry: Record<string, unknown>) => JSON.stringify(entry);

  it("leaves a reference nothing maps to untouched instead of inventing one", () => {
    const content = [
      forkedLine({
        type: "user",
        uuid: "fork-1",
        parentUuid: null,
        forkedFrom: { sessionId: "src", messageUuid: "src-1" },
        message: { role: "user", content: "kept" },
      }),
      forkedLine({
        type: "system",
        subtype: "compact_boundary",
        uuid: "fork-2",
        parentUuid: null,
        forkedFrom: { sessionId: "src", messageUuid: "src-2" },
        compactMetadata: {
          preservedMessages: {
            anchorUuid: "src-1",
            uuids: ["src-1", "src-sliced-away"],
            allUuids: ["src-1"],
          },
        },
      }),
    ].join("\n");

    const result = repairForkedCompactBoundaries(content);
    const boundary = parseTranscript(result.content).find(
      (entry) => entry.subtype === "compact_boundary",
    );
    expect(boundary?.compactMetadata?.preservedMessages).toEqual({
      anchorUuid: "fork-1",
      uuids: ["fork-1", "src-sliced-away"],
      allUuids: ["fork-1"],
    });
    expect(result.stats).toMatchObject({ boundaries: 1, rewritten: 3, unresolved: 1 });
  });

  it("passes through a transcript with no compaction, including a partial last line", () => {
    const content = `${forkedLine({ type: "user", uuid: "fork-1", parentUuid: null })}\n{"type":"assist`;
    const result = repairForkedCompactBoundaries(content);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(content);
    expect(result.stats.boundaries).toBe(0);
  });
});
