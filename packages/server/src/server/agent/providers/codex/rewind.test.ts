import { describe, expect, test } from "vitest";

import type {
  CodexThreadForkParams,
  CodexThreadForkResponse,
  CodexThreadRevertParams,
  CodexThreadRevertResponse,
  CodexThreadRollbackParams,
  CodexThreadRollbackResponse,
} from "./app-server-transport.js";
import {
  type CodexUserMessageTurnIndex,
  type CodexRewindClient,
  revertCodexConversation,
} from "./rewind.js";

interface RecordedCodexCall {
  method: string;
  params: unknown;
}

class FakeCodex implements CodexRewindClient {
  readonly calls: RecordedCodexCall[] = [];

  constructor(private readonly historyMode: "legacy" | "paginated" = "legacy") {}

  async forkThread(params: CodexThreadForkParams): Promise<CodexThreadForkResponse> {
    this.calls.push({ method: "thread/fork", params });
    return {
      thread: {
        id: "backup-thread",
        sessionId: "backup-thread",
        forkedFromId: params.threadId,
        turns: [],
      },
      model: "gpt-5.4-mini",
      modelProvider: "openai",
      serviceTier: null,
      cwd: "/workspace/project",
      runtimeWorkspaceRoots: [],
      instructionSources: [],
      approvalPolicy: "on-request",
      approvalsReviewer: null,
      sandbox: { type: "workspaceWrite", networkAccess: false },
      activePermissionProfile: null,
      reasoningEffort: null,
    };
  }

  async rollbackThread(params: CodexThreadRollbackParams): Promise<CodexThreadRollbackResponse> {
    this.calls.push({ method: "thread/rollback", params });
    return { thread: { id: params.threadId, sessionId: params.threadId, turns: [] } };
  }

  async revertThread(params: CodexThreadRevertParams): Promise<CodexThreadRevertResponse> {
    this.calls.push({ method: "thread/revert", params });
    return { thread: { id: params.threadId, sessionId: params.threadId } };
  }

  request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "thread/read") {
      return Promise.resolve({ thread: { id: "source-thread", historyMode: this.historyMode } });
    }
    if (method === "thread/unsubscribe") {
      return Promise.resolve({ status: "unsubscribed" });
    }
    throw new Error(`Unexpected request: ${method}`);
  }
}

class CodexMessageTurns implements CodexUserMessageTurnIndex {
  constructor(
    private readonly indexesByMessageId: Map<string, number>,
    private readonly turnIdsByMessageId: Map<string, string> = new Map(),
  ) {}

  resolve(messageId: string): { index: number; turnId: string | null } | null {
    const index = this.indexesByMessageId.get(messageId);
    return index === undefined
      ? null
      : { index, turnId: this.turnIdsByMessageId.get(messageId) ?? null };
  }

  count(): number {
    return this.indexesByMessageId.size;
  }
}

const readSourceThread = {
  method: "thread/read",
  params: { threadId: "source-thread", includeTurns: false },
};

const forkBackupThread = {
  method: "thread/fork",
  params: {
    threadId: "source-thread",
    cwd: "/workspace/project",
    model: "gpt-5.4-mini",
    serviceTier: null,
    excludeTurns: true,
    persistExtendedHistory: true,
  },
};

const unsubscribeBackupThread = {
  method: "thread/unsubscribe",
  params: { threadId: "backup-thread" },
};

describe("Codex Rewind", () => {
  test("rolls back a legacy thread in place after forking an untouched backup", async () => {
    const codex = new FakeCodex("legacy");
    const userMessageTurns = new CodexMessageTurns(
      new Map([
        ["codex-first", 0],
        ["codex-second", 1],
      ]),
    );

    const result = await revertCodexConversation({
      client: codex,
      threadId: "source-thread",
      messageId: "codex-first",
      cwd: "/workspace/project",
      model: "gpt-5.4-mini",
      serviceTier: null,
      userMessageTurns,
    });

    expect(codex.calls).toEqual([
      readSourceThread,
      forkBackupThread,
      unsubscribeBackupThread,
      { method: "thread/rollback", params: { threadId: "source-thread", numTurns: 2 } },
    ]);
    expect(result).toEqual({ backupThreadId: "backup-thread" });
  });

  test("rolls back past a native user message id hydrated from app-server history", async () => {
    const codex = new FakeCodex("legacy");
    const userMessageTurns = new CodexMessageTurns(
      new Map([
        ["codex-first", 0],
        ["codex-second", 1],
        ["codex-third", 2],
      ]),
    );

    await revertCodexConversation({
      client: codex,
      threadId: "source-thread",
      messageId: "codex-second",
      userMessageTurns,
    });

    expect(codex.calls.filter((call) => call.method === "thread/rollback")).toEqual([
      { method: "thread/rollback", params: { threadId: "source-thread", numTurns: 2 } },
    ]);
  });

  test("reverts a paginated thread in place before the target turn after forking an untouched backup", async () => {
    const codex = new FakeCodex("paginated");
    const userMessageTurns = new CodexMessageTurns(
      new Map([
        ["codex-first", 0],
        ["codex-second", 1],
      ]),
      new Map([
        ["codex-first", "turn-first"],
        ["codex-second", "turn-second"],
      ]),
    );

    const result = await revertCodexConversation({
      client: codex,
      threadId: "source-thread",
      messageId: "codex-first",
      cwd: "/workspace/project",
      model: "gpt-5.4-mini",
      serviceTier: null,
      userMessageTurns,
    });

    expect(codex.calls).toEqual([
      readSourceThread,
      forkBackupThread,
      unsubscribeBackupThread,
      {
        method: "thread/revert",
        params: { threadId: "source-thread", beforeTurnId: "turn-first" },
      },
    ]);
    expect(result).toEqual({ backupThreadId: "backup-thread" });
  });

  test("does not fork a paginated thread when the target turn id is unavailable", async () => {
    const codex = new FakeCodex("paginated");
    const userMessageTurns = new CodexMessageTurns(new Map([["codex-first", 0]]));

    await expect(
      revertCodexConversation({
        client: codex,
        threadId: "source-thread",
        messageId: "codex-first",
        cwd: "/workspace/project",
        model: "gpt-5.4-mini",
        serviceTier: null,
        userMessageTurns,
      }),
    ).rejects.toThrow("Codex could not find the turn containing user message codex-first");

    expect(codex.calls).toEqual([readSourceThread]);
  });

  test("declines to rewind when the user message is not in the Codex thread", async () => {
    const codex = new FakeCodex();
    const userMessageTurns = new CodexMessageTurns(new Map([["codex-first", 0]]));

    await expect(
      revertCodexConversation({
        client: codex,
        threadId: "source-thread",
        messageId: "missing-message",
        userMessageTurns,
      }),
    ).rejects.toThrow("Codex could not find user message missing-message");
    expect(codex.calls).toEqual([]);
  });
});
