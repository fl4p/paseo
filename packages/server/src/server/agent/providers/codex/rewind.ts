import type {
  CodexThreadForkParams,
  CodexThreadForkResponse,
  CodexThreadRevertParams,
  CodexThreadRevertResponse,
  CodexThreadRollbackParams,
  CodexThreadRollbackResponse,
} from "./app-server-transport.js";
import {
  parseCodexThreadForkResponse,
  parseCodexThreadRevertResponse,
  parseCodexThreadRollbackResponse,
} from "./app-server-transport.js";

export interface CodexRewindClient {
  forkThread?(params: CodexThreadForkParams): Promise<CodexThreadForkResponse>;
  rollbackThread?(params: CodexThreadRollbackParams): Promise<CodexThreadRollbackResponse>;
  revertThread?(params: CodexThreadRevertParams): Promise<CodexThreadRevertResponse>;
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
}

export interface CodexUserMessageTurnIndex {
  resolve(messageId: string): { index: number; turnId: string | null } | null;
  count(): number;
}

export interface CodexRewindResult {
  backupThreadId: string;
}

type CodexThreadHistoryMode = "legacy" | "paginated";

type CodexInPlaceRewind =
  | { method: "thread/revert"; params: CodexThreadRevertParams }
  | { method: "thread/rollback"; params: CodexThreadRollbackParams };

async function readCodexThreadHistoryMode(
  client: CodexRewindClient,
  threadId: string,
): Promise<CodexThreadHistoryMode> {
  const response = await client.request("thread/read", { threadId, includeTurns: false });
  if (typeof response !== "object" || response === null || !("thread" in response)) {
    throw new Error("Codex thread/read did not return thread metadata");
  }
  const thread = response.thread;
  if (typeof thread !== "object" || thread === null || !("historyMode" in thread)) {
    return "legacy";
  }
  if (thread.historyMode === "legacy" || thread.historyMode === "paginated") {
    return thread.historyMode;
  }
  throw new Error(`Codex thread/read returned unknown history mode ${String(thread.historyMode)}`);
}

async function forkCodexThread(
  client: CodexRewindClient,
  params: CodexThreadForkParams,
): Promise<CodexThreadForkResponse> {
  if (client.forkThread) {
    return client.forkThread(params);
  }
  return parseCodexThreadForkResponse(await client.request("thread/fork", params));
}

async function rollbackCodexThread(
  client: CodexRewindClient,
  params: CodexThreadRollbackParams,
): Promise<CodexThreadRollbackResponse> {
  if (client.rollbackThread) {
    return client.rollbackThread(params);
  }
  return parseCodexThreadRollbackResponse(await client.request("thread/rollback", params));
}

async function revertCodexThread(
  client: CodexRewindClient,
  params: CodexThreadRevertParams,
): Promise<CodexThreadRevertResponse> {
  if (client.revertThread) {
    return client.revertThread(params);
  }
  return parseCodexThreadRevertResponse(await client.request("thread/revert", params));
}

// Paginated threads reject thread/rollback; thread/revert is their in-place equivalent and needs
// the native id of the first dropped turn.
function planInPlaceRewind(input: {
  historyMode: CodexThreadHistoryMode;
  threadId: string;
  messageId: string;
  turnId: string | null;
  numTurns: number;
}): CodexInPlaceRewind {
  if (input.historyMode === "legacy") {
    return {
      method: "thread/rollback",
      params: { threadId: input.threadId, numTurns: input.numTurns },
    };
  }
  if (!input.turnId) {
    throw new Error(`Codex could not find the turn containing user message ${input.messageId}`);
  }
  return {
    method: "thread/revert",
    params: { threadId: input.threadId, beforeTurnId: input.turnId },
  };
}

export async function revertCodexConversation(input: {
  client: CodexRewindClient;
  threadId: string | null;
  messageId: string;
  cwd?: string | null;
  model?: string | null;
  serviceTier?: string | null;
  userMessageTurns: CodexUserMessageTurnIndex;
}): Promise<CodexRewindResult> {
  const threadId = input.threadId;
  if (!threadId) {
    throw new Error("Codex thread is not ready for rewind");
  }

  const targetTurn = input.userMessageTurns.resolve(input.messageId);
  if (targetTurn === null) {
    throw new Error(`Codex could not find user message ${input.messageId} in the current thread`);
  }

  const currentUserTurnCount = input.userMessageTurns.count();
  const numTurns = currentUserTurnCount - targetTurn.index;
  if (numTurns < 0) {
    throw new Error(`Codex user message ${input.messageId} is outside the current thread`);
  }

  const rewind = planInPlaceRewind({
    historyMode: await readCodexThreadHistoryMode(input.client, threadId),
    threadId,
    messageId: input.messageId,
    turnId: targetTurn.turnId,
    numTurns,
  });

  // Codex sends the thread's session id as the OpenAI prompt_cache_key, and a fork gets a new
  // session id. Rewinding the thread itself keeps the key, so the next turn reuses the cached
  // prefix instead of starting cold. The untouched fork is the recovery copy of the pre-rewind
  // conversation: `codex resume <backupThreadId>`.
  const backup = await forkCodexThread(input.client, {
    threadId,
    cwd: input.cwd ?? null,
    model: input.model ?? null,
    serviceTier: input.serviceTier ?? null,
    excludeTurns: true,
    persistExtendedHistory: true,
  });
  const backupThreadId = backup.thread.id;
  // thread/fork subscribes this connection to the new thread; Paseo never drives the backup.
  await input.client.request("thread/unsubscribe", { threadId: backupThreadId });

  // Codex rewind is chat-only by design. File edits from rewound turns stay
  // on disk; a future file primitive would be a separate capability.
  if (rewind.method === "thread/revert") {
    await revertCodexThread(input.client, rewind.params);
  } else {
    await rollbackCodexThread(input.client, rewind.params);
  }
  return { backupThreadId };
}
