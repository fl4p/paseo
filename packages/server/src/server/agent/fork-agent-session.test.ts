import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { forkAgentSessionNatively, type ForkAgentSessionDeps } from "./fork-agent-session.js";
import { forkClaudeSession } from "./providers/claude/fork-session.js";
import { FakeClaudeSdk } from "./providers/claude/test-rewind-claude-sdk.js";
import { convertClaudeHistoryEntry } from "./providers/claude/agent.js";
import type { AgentSessionConfig, AgentTimelineItem } from "./agent-sdk-types.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

const logger = pino({ level: "silent" });

/**
 * A source transcript with a completed compaction in the middle: the shape that
 * makes the attachment fork blow up (it replays everything before the boundary)
 * and that the native fork is supposed to inherit instead.
 */
const SOURCE_ENTRIES = [
  { type: "user", uuid: "u1", message: { role: "user", content: "first task" } },
  {
    type: "assistant",
    uuid: "a1",
    message: {
      id: "msg_1",
      role: "assistant",
      content: [{ type: "text", text: "on it" }],
      stop_reason: "end_turn",
    },
  },
  {
    type: "system",
    subtype: "compact_boundary",
    uuid: "c1",
    compact_metadata: { trigger: "auto", pre_tokens: 190000 },
  },
  { type: "user", uuid: "u2", message: { role: "user", content: "second task" } },
  {
    type: "assistant",
    uuid: "a2",
    message: {
      id: "msg_2",
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
    },
  },
  { type: "user", uuid: "u3", message: { role: "user", content: "third task" } },
  {
    type: "assistant",
    uuid: "a3",
    message: {
      id: "msg_3",
      role: "assistant",
      content: [{ type: "text", text: "also done" }],
      stop_reason: "end_turn",
    },
  },
];

function toJsonl(entries: readonly unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n");
}

/**
 * Fake that behaves like the real `forkSession`: it writes a NEW transcript
 * file containing the copied slice, so the import step downstream has something
 * real to hydrate from. Without this the test could not tell a working fork
 * from one that returns a session id pointing at nothing.
 */
class TranscriptWritingClaudeSdk extends FakeClaudeSdk {
  constructor(
    private readonly dir: string,
    private readonly sourceSessionId: string,
  ) {
    super();
  }

  override async forkSession(
    sessionId: string,
    options?: { upToMessageId?: string },
  ): Promise<{ sessionId: string }> {
    const result = await super.forkSession(sessionId, options);
    const source = readFileSync(join(this.dir, `${this.sourceSessionId}.jsonl`), "utf8");
    const lines = source.split("\n").filter((line) => line.trim().length > 0);
    const cutoff = options?.upToMessageId
      ? lines.findIndex(
          (line) => (JSON.parse(line) as { uuid?: string }).uuid === options.upToMessageId,
        )
      : lines.length - 1;
    const copied = lines.slice(0, cutoff + 1).map((line, index) => {
      const entry = JSON.parse(line) as Record<string, unknown>;
      // The real SDK remaps every uuid; mirror that so the test proves the
      // import reads the FORK's file rather than the source's.
      return JSON.stringify({ ...entry, uuid: `fork-${index}`, session_id: result.sessionId });
    });
    writeFileSync(join(this.dir, `${result.sessionId}.jsonl`), copied.join("\n"), "utf8");
    return result;
  }
}

function timelineFromTranscript(path: string): AgentTimelineItem[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => convertClaudeHistoryEntry(JSON.parse(line), mapTextBlocks));
}

/** Minimal stand-in for the provider's block mapper: text blocks become messages. */
function mapTextBlocks(content: string | { type?: string; text?: string }[]): AgentTimelineItem[] {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
  return blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => ({ type: "assistant_message", text: block.text ?? "" }));
}

function row(seq: number, item: AgentTimelineItem): AgentTimelineRow {
  return { seq, timestamp: `2026-01-01T00:00:0${seq}.000Z`, item };
}

const SOURCE_ROWS: AgentTimelineRow[] = [
  row(1, { type: "user_message", text: "first task", messageId: "u1" }),
  row(2, { type: "assistant_message", text: "on it", messageId: "msg_1" }),
  row(3, { type: "compaction", status: "completed", trigger: "auto" }),
  row(4, { type: "user_message", text: "second task", messageId: "u2" }),
  row(5, { type: "assistant_message", text: "done", messageId: "msg_2" }),
  row(6, { type: "user_message", text: "third task", messageId: "u3" }),
  row(7, { type: "assistant_message", text: "also done", messageId: "msg_3" }),
];

/**
 * The source agent is deliberately NOT on the daemon defaults: a fork that
 * re-derives its config would silently move it back onto them, which also
 * throws away the `tools`/`system` half of the prompt-cache prefix.
 */
const SOURCE_CONFIG: AgentSessionConfig = {
  provider: "claude",
  cwd: "/workspace",
  model: "claude-opus-4-5",
  modeId: "acceptEdits",
  thinkingOptionId: "think-hard",
  systemPrompt: "you are forked",
  toolPolicy: { mode: "allowlist", tools: ["Read"] } as AgentSessionConfig["toolPolicy"],
  mcpServers: { docs: { type: "http", url: "https://example.test/mcp" } },
  providerOptions: { claude: { dangerouslySkipPermissions: false } },
  title: "source agent",
  internal: true,
};

describe("forkAgentSessionNatively", () => {
  let dir: string;
  let sdk: TranscriptWritingClaudeSdk;
  let deps: ForkAgentSessionDeps;
  let importedTimelines: AgentTimelineItem[][];
  let importedConfigs: Partial<AgentSessionConfig>[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "paseo-fork-"));
    writeFileSync(join(dir, "source-session.jsonl"), toJsonl(SOURCE_ENTRIES), "utf8");
    sdk = new TranscriptWritingClaudeSdk(dir, "source-session");
    sdk.setNextSessionId("forked-session");
    importedTimelines = [];
    importedConfigs = [];
    deps = {
      loadAgent: vi.fn(async () => ({
        cwd: "/workspace",
        workspaceId: "ws-1",
        config: SOURCE_CONFIG,
      })),
      fetchTimeline: vi.fn(() => ({ epoch: "epoch-1", rows: SOURCE_ROWS })),
      hasInFlightRun: vi.fn(() => false),
      forkProviderSession: async (_agentId, input) => {
        const fork = await forkClaudeSession({
          sdk,
          sessionId: "source-session",
          boundaryMessageId: input.boundaryMessageId,
          atCompletedTurn: input.atCompletedTurn,
          readTranscript: () => readFileSync(join(dir, "source-session.jsonl"), "utf8"),
        });
        return { providerHandleId: fork.sessionId, provider: "claude", cwd: "/workspace" };
      },
      importProviderSession: async (input) => {
        const timeline = timelineFromTranscript(join(dir, `${input.providerHandleId}.jsonl`));
        importedTimelines.push(timeline);
        importedConfigs.push(input.config);
        return { agentId: "agent-forked", timelineSize: timeline.length, createdWorkspace: null };
      },
      registerCreatedWorkspace: vi.fn(async () => {}),
      validateForkTarget: vi.fn(async () => {}),
      deleteForkedProviderSession: vi.fn(async () => {}),
      logger,
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("hydrates the new agent from the forked transcript, not the source one", async () => {
    const result = await forkAgentSessionNatively(
      { agentId: "agent-source", requestId: "req-1" },
      deps,
    );

    expect(result).toEqual({
      agentId: "agent-forked",
      providerHandleId: "forked-session",
      timelineSize: 7,
    });
    // The fork file exists and carries remapped uuids, so the timeline below
    // could only have come from it.
    const timeline = importedTimelines[0] ?? [];
    expect(
      timeline.filter((item) => item.type === "user_message").map((item) => item.text),
    ).toEqual(["first task", "second task", "third task"]);
    // The compaction marker survives the copy, which is what lets the resumed
    // fork rebuild the compacted context instead of the raw history.
    expect(timeline.some((item) => item.type === "compaction")).toBe(true);
    expect(sdk.recordedForkCalls).toEqual([{ sessionId: "source-session", upToMessageId: "a3" }]);
  });

  it("maps a paseo assistant message id to the provider uuid before slicing", async () => {
    const result = await forkAgentSessionNatively(
      { agentId: "agent-source", requestId: "req-2", boundaryMessageId: "msg_2" },
      deps,
    );

    // "msg_2" is the live API id of the assistant turn whose transcript uuid is
    // "a2"; the fork must slice there, not at the API id (which is not a uuid).
    expect(sdk.recordedForkCalls).toEqual([{ sessionId: "source-session", upToMessageId: "a2" }]);
    expect(result.timelineSize).toBe(5);
    const timeline = importedTimelines[0] ?? [];
    expect(
      timeline.filter((item) => item.type === "user_message").map((item) => item.text),
    ).toEqual(["first task", "second task"]);
  });

  it("resolves a cursor boundary to the nearest preceding message id", async () => {
    // Seq 6 is a user_message; a cursor can also land on a row with no message
    // id at all, so the resolver walks back to the last one that has one.
    await forkAgentSessionNatively(
      { agentId: "agent-source", requestId: "req-3", boundaryCursor: { epoch: "epoch-1", seq: 6 } },
      deps,
    );
    expect(sdk.recordedForkCalls).toEqual([{ sessionId: "source-session", upToMessageId: "u3" }]);
  });

  it("rejects a stale cursor instead of forking the whole session", async () => {
    await expect(
      forkAgentSessionNatively(
        {
          agentId: "agent-source",
          requestId: "req-4",
          boundaryCursor: { epoch: "epoch-0", seq: 6 },
        },
        deps,
      ),
    ).rejects.toThrow(/no longer available/);
    expect(sdk.recordedForkCalls).toEqual([]);
  });

  it("refuses a cross-directory fork, which the provider store could not resume", async () => {
    await expect(
      forkAgentSessionNatively(
        { agentId: "agent-source", requestId: "req-5", cwd: "/other" },
        deps,
      ),
    ).rejects.toThrow(/same working directory/);
    expect(sdk.recordedForkCalls).toEqual([]);
  });

  /**
   * Point the source agent at a REAL directory and record the cwd the import
   * lands on. The whole point of these cases is that the comparison resolves
   * directory identity rather than comparing strings, so the paths have to
   * exist.
   */
  function useRealSourceDirectory(): { realCwd: string; importedCwds: string[] } {
    const realCwd = join(dir, "project");
    mkdirSync(realCwd, { recursive: true });
    const importedCwds: string[] = [];
    const source = { cwd: realCwd, workspaceId: "ws-1", config: SOURCE_CONFIG };
    deps.loadAgent = vi.fn(() => Promise.resolve(source));
    const importProviderSession = deps.importProviderSession;
    deps.importProviderSession = (input) => {
      importedCwds.push(input.cwd);
      return importProviderSession(input);
    };
    return { realCwd, importedCwds };
  }

  function forkWithCwd(cwd: string, requestId: string) {
    return forkAgentSessionNatively({ agentId: "agent-source", requestId, cwd }, deps);
  }

  it("accepts a trailing separator as the same directory", async () => {
    const { realCwd } = useRealSourceDirectory();
    await expect(forkWithCwd(`${realCwd}/`, "req-slash")).resolves.toBeTruthy();
  });

  it("accepts dot segments as the same directory", async () => {
    const { realCwd } = useRealSourceDirectory();
    await expect(forkWithCwd(`${realCwd}/./`, "req-dot")).resolves.toBeTruthy();
    await expect(forkWithCwd(join(realCwd, "..", "project"), "req-dotdot")).resolves.toBeTruthy();
  });

  it("accepts the same directory reached through a symlink", async () => {
    const { realCwd } = useRealSourceDirectory();
    const link = join(dir, "link-to-project");
    symlinkSync(realCwd, link, "dir");
    await expect(forkWithCwd(link, "req-symlink")).resolves.toBeTruthy();
  });

  it("accepts a case difference on a case-insensitive filesystem", async () => {
    useRealSourceDirectory();
    const swapped = join(dir, "PROJECT");
    // Only meaningful where the filesystem itself folds case; on a
    // case-sensitive one this really is a different (missing) directory.
    if (!existsSync(swapped)) {
      expect(existsSync(swapped)).toBe(false);
      return;
    }
    await expect(forkWithCwd(swapped, "req-case")).resolves.toBeTruthy();
  });

  it("still refuses a genuine worktree, whose real path differs", async () => {
    useRealSourceDirectory();
    const worktree = join(dir, "project-worktree");
    mkdirSync(worktree, { recursive: true });
    await expect(forkWithCwd(worktree, "req-worktree")).rejects.toThrow(/same working directory/);
    expect(sdk.recordedForkCalls).toEqual([]);
  });

  it("refuses a path whose real directory escapes through a symlink", async () => {
    const { realCwd, importedCwds } = useRealSourceDirectory();
    // `source/link -> other/child`. Built as a string on purpose: `join` would
    // collapse `link/..` lexically and destroy the case under test.
    const other = join(dir, "other", "child");
    mkdirSync(other, { recursive: true });
    symlinkSync(other, join(realCwd, "link"), "dir");
    const escaped = `${realCwd}/link/..`;
    // Lexically this normalizes to the source directory; the directory it
    // really names is `<dir>/other`. Importing under `source.cwd` would attach
    // the fork to a context the user did not ask for.
    expect(realpathSync.native(escaped)).toBe(realpathSync.native(join(dir, "other")));

    await expect(forkWithCwd(escaped, "req-escape")).rejects.toThrow(/same working directory/);
    expect(sdk.recordedForkCalls).toEqual([]);
    expect(importedCwds).toEqual([]);
  });

  it("refuses a requested directory that does not exist", async () => {
    const { importedCwds } = useRealSourceDirectory();
    await expect(forkWithCwd(join(dir, "project-gone"), "req-missing")).rejects.toThrow(
      /same working directory/,
    );
    expect(sdk.recordedForkCalls).toEqual([]);
    expect(importedCwds).toEqual([]);
  });

  it("imports under the source agent's own spelling of the directory", async () => {
    const { realCwd, importedCwds } = useRealSourceDirectory();
    await forkWithCwd(`${realCwd}/`, "req-spelling");
    expect(importedCwds).toEqual([realCwd]);
  });

  it("starts the fork on the source agent's model, mode and tools, not the daemon defaults", async () => {
    await forkAgentSessionNatively({ agentId: "agent-source", requestId: "req-config" }, deps);

    expect(importedConfigs[0]).toEqual({
      model: "claude-opus-4-5",
      modeId: "acceptEdits",
      thinkingOptionId: "think-hard",
      systemPrompt: "you are forked",
      toolPolicy: SOURCE_CONFIG.toolPolicy,
      mcpServers: SOURCE_CONFIG.mcpServers,
      providerOptions: SOURCE_CONFIG.providerOptions,
    });
  });

  it("does not carry over what names the source rather than how it runs", async () => {
    await forkAgentSessionNatively({ agentId: "agent-source", requestId: "req-config-2" }, deps);

    const config = importedConfigs[0] ?? {};
    // cwd and provider come from the fork itself, the title is re-derived from
    // the imported timeline, and a fork is a user-visible agent even when the
    // source was an internal system one.
    expect(config).not.toHaveProperty("cwd");
    expect(config).not.toHaveProperty("provider");
    expect(config).not.toHaveProperty("title");
    expect(config).not.toHaveProperty("internal");
  });

  it("refuses before the irreversible fork when the target is unusable", async () => {
    // The provider fork writes a new transcript that cannot be un-written, so
    // anything knowable up front has to fail before it, not after.
    deps.validateForkTarget = vi.fn(async () => {
      throw new Error("Workspace not found: ws-gone");
    });

    await expect(
      forkAgentSessionNatively({ agentId: "agent-source", requestId: "req-validate" }, deps),
    ).rejects.toThrow(/Workspace not found/);
    expect(sdk.recordedForkCalls).toEqual([]);
    expect(deps.deleteForkedProviderSession).not.toHaveBeenCalled();
  });

  it("deletes the forked provider session when the import afterwards fails", async () => {
    deps.importProviderSession = vi.fn(() => Promise.reject(new Error("hydration failed")));

    await expect(
      forkAgentSessionNatively({ agentId: "agent-source", requestId: "req-rollback" }, deps),
    ).rejects.toThrow("hydration failed");
    // Otherwise the fork stays on disk and later surfaces in the
    // importable-sessions list as a session the user never created.
    expect(deps.deleteForkedProviderSession).toHaveBeenCalledWith("agent-source", {
      providerHandleId: "forked-session",
    });
  });

  it("deletes the forked provider session when registering its workspace fails", async () => {
    deps.importProviderSession = vi.fn(() =>
      Promise.resolve({
        agentId: "agent-forked",
        timelineSize: 1,
        createdWorkspace: { workspaceId: "ws-new" } as never,
      }),
    );
    deps.registerCreatedWorkspace = vi.fn(() => Promise.reject(new Error("registry offline")));

    await expect(
      forkAgentSessionNatively({ agentId: "agent-source", requestId: "req-rollback-2" }, deps),
    ).rejects.toThrow("registry offline");
    expect(deps.deleteForkedProviderSession).toHaveBeenCalledWith("agent-source", {
      providerHandleId: "forked-session",
    });
  });

  it("still reports the original failure when the rollback itself fails", async () => {
    deps.importProviderSession = vi.fn(() => Promise.reject(new Error("hydration failed")));
    deps.deleteForkedProviderSession = vi.fn(() => Promise.reject(new Error("delete refused")));

    // A failed rollback must not become the error the user sees: it would hide
    // the reason the fork failed behind a cleanup detail.
    await expect(
      forkAgentSessionNatively({ agentId: "agent-source", requestId: "req-rollback-3" }, deps),
    ).rejects.toThrow("hydration failed");
    expect(deps.deleteForkedProviderSession).toHaveBeenCalled();
  });

  it("forks the last completed turn when a run is in flight", async () => {
    // The user asked to fork "now", with a reply still streaming. The tail of
    // the transcript is a tool_use whose result has not been written yet, so
    // forking it would clone a call that can never be answered.
    writeFileSync(
      join(dir, "source-session.jsonl"),
      toJsonl([
        ...SOURCE_ENTRIES,
        { type: "user", uuid: "u4", message: { role: "user", content: "fourth task" } },
        {
          type: "assistant",
          uuid: "a4",
          message: {
            id: "msg_4",
            role: "assistant",
            content: [{ type: "tool_use", id: "tool_1", name: "Read", input: {} }],
            stop_reason: "tool_use",
          },
        },
      ]),
      "utf8",
    );
    deps.hasInFlightRun = vi.fn(() => true);

    await forkAgentSessionNatively({ agentId: "agent-source", requestId: "req-in-flight" }, deps);

    expect(sdk.recordedForkCalls).toEqual([{ sessionId: "source-session", upToMessageId: "a3" }]);
    const timeline = importedTimelines[0] ?? [];
    // The fork stops at the last completed reply: the in-flight user prompt and
    // its unanswered tool call are not in it.
    expect(
      timeline.filter((item) => item.type === "user_message").map((item) => item.text),
    ).toEqual(["first task", "second task", "third task"]);
  });

  it("keeps the user's boundary when one was picked mid-run", async () => {
    // An explicit boundary is a position the user chose; a running turn behind
    // it does not move it.
    deps.hasInFlightRun = vi.fn(() => true);
    await forkAgentSessionNatively(
      { agentId: "agent-source", requestId: "req-in-flight-2", boundaryMessageId: "msg_2" },
      deps,
    );
    expect(sdk.recordedForkCalls).toEqual([{ sessionId: "source-session", upToMessageId: "a2" }]);
  });

  it("registers a workspace the import had to create", async () => {
    const workspace = { workspaceId: "ws-new" } as never;
    deps.importProviderSession = async () => ({
      agentId: "agent-forked",
      timelineSize: 1,
      createdWorkspace: workspace,
    });
    await forkAgentSessionNatively({ agentId: "agent-source", requestId: "req-6" }, deps);
    expect(deps.registerCreatedWorkspace).toHaveBeenCalledWith(workspace);
  });
});
