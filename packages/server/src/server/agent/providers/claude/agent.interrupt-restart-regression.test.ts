import { afterEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import { streamSession } from "../test-utils/session-stream-adapter.js";
import { AgentManager, type AgentManagerEvent } from "../../agent-manager.js";
import { startAgentRun } from "../../agent-prompt.js";
import type { AgentSession, AgentStreamEvent, AgentTimelineItem } from "../../agent-sdk-types.js";

interface QueryMock {
  next: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  return: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  supportedModels: ReturnType<typeof vi.fn>;
  supportedCommands: ReturnType<typeof vi.fn>;
  rewindFiles: ReturnType<typeof vi.fn>;
  cancelAsyncMessage: ReturnType<typeof vi.fn>;
  applyFlagSettings: ReturnType<typeof vi.fn>;
  stopTask: ReturnType<typeof vi.fn>;
  [Symbol.asyncIterator]: () => AsyncIterator<Record<string, unknown>, void>;
}

interface PromptRecord {
  text: string;
  uuid: string | null;
}

interface AsyncQueue<T> {
  push: (value: T) => void;
  next: () => Promise<IteratorResult<T, void>>;
  end: () => void;
}

type ScriptedQuery = QueryMock & {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  prompts: PromptRecord[];
};

type PromptHandler = (input: {
  prompt: Record<string, unknown>;
  promptRecord: PromptRecord;
  query: ScriptedQuery;
}) => void | Promise<void>;

const queryFactory = vi.fn();

function createAsyncQueue<T>(): AsyncQueue<T> {
  const items: T[] = [];
  const resolvers: Array<(value: IteratorResult<T, void>) => void> = [];
  let ended = false;

  return {
    push(value) {
      if (ended) {
        return;
      }
      const resolve = resolvers.shift();
      if (resolve) {
        resolve({ value, done: false });
        return;
      }
      items.push(value);
    },
    async next() {
      const value = items.shift();
      if (value !== undefined) {
        return { value, done: false };
      }
      if (ended) {
        return { value: undefined, done: true };
      }
      return await new Promise<IteratorResult<T, void>>((resolve) => {
        resolvers.push(resolve);
      });
    },
    end() {
      ended = true;
      while (resolvers.length > 0) {
        const resolve = resolvers.shift();
        resolve?.({ value: undefined, done: true });
      }
    },
  };
}

function buildUsage() {
  return {
    input_tokens: 1,
    cache_read_input_tokens: 0,
    output_tokens: 1,
  };
}

function buildSuccessResult(sessionId: string) {
  return {
    type: "result",
    subtype: "success",
    usage: buildUsage(),
    total_cost_usd: 0,
    session_id: sessionId,
  };
}

function extractPromptText(message: Record<string, unknown>): string {
  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") {
        return [];
      }
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    })
    .join("");
}

function createScriptedQuery(params: {
  prompt: AsyncIterable<unknown>;
  sessionId: string;
  handlePrompt?: PromptHandler;
}): ScriptedQuery {
  const output = createAsyncQueue<Record<string, unknown>>();
  const prompts: PromptRecord[] = [];

  const scriptedQuery = {
    next: vi.fn(() => output.next()),
    interrupt: vi.fn(async () => undefined),
    return: vi.fn(async () => {
      output.end();
    }),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    cancelAsyncMessage: vi.fn(async () => true),
    // The AgentManager path applies session flags on start; the bare session path never does.
    applyFlagSettings: vi.fn(async () => undefined),
    stopTask: vi.fn(async () => undefined),
    emit: (message: Record<string, unknown>) => {
      output.push(message);
    },
    end: () => {
      output.end();
    },
    prompts,
    [Symbol.asyncIterator]() {
      return this;
    },
  } satisfies ScriptedQuery;

  scriptedQuery.emit({
    type: "system",
    subtype: "init",
    session_id: params.sessionId,
    permissionMode: "default",
    model: "opus",
  });

  void (async () => {
    for await (const prompt of params.prompt) {
      const promptMessage = prompt as Record<string, unknown>;
      const promptRecord = {
        text: extractPromptText(promptMessage),
        uuid: typeof promptMessage.uuid === "string" ? promptMessage.uuid : null,
      };
      prompts.push(promptRecord);
      await params.handlePrompt?.({
        prompt: promptMessage,
        promptRecord,
        query: scriptedQuery,
      });
    }
  })();

  return scriptedQuery;
}

async function collectUntilTerminal(
  stream: AsyncGenerator<AgentStreamEvent>,
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (
      event.type === "turn_completed" ||
      event.type === "turn_failed" ||
      event.type === "turn_canceled"
    ) {
      break;
    }
  }
  return events;
}

/** Pulls the stream forward without closing it, so the caller can keep reading afterwards. */
async function consumeUntil(
  stream: AsyncGenerator<AgentStreamEvent>,
  matches: (event: AgentStreamEvent) => boolean,
): Promise<void> {
  while (true) {
    const next = await stream.next();
    if (next.done) throw new Error("Stream ended before the expected event");
    if (matches(next.value)) return;
  }
}

function collectAssistantText(events: AgentStreamEvent[]): string {
  return events
    .flatMap((event) => {
      if (event.type !== "timeline" || event.item.type !== "assistant_message") {
        return [];
      }
      return [event.item.text];
    })
    .join("");
}

function subscribeToEvents(session: {
  subscribe: (callback: (event: AgentStreamEvent) => void) => () => void;
}) {
  const queue = createAsyncQueue<AgentStreamEvent>();
  const unsubscribe = session.subscribe((event) => {
    queue.push(event);
  });

  return {
    next: () => queue.next(),
    close: () => {
      unsubscribe();
      queue.end();
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 2_000;
  const intervalMs = options?.intervalMs ?? 5;
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

afterEach(() => {
  queryFactory.mockReset();
});

test("interrupt only calls query.interrupt and leaves the query open", async () => {
  const logger = createTestLogger();
  const queries: ScriptedQuery[] = [];

  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const scriptedQuery = createScriptedQuery({
      prompt,
      sessionId: "interrupt-keep-query-session",
    });
    queries.push(scriptedQuery);
    return scriptedQuery;
  });

  const client = new ClaudeAgentClient({
    logger,
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });

  const firstTurn = streamSession(session, "first prompt");
  await firstTurn.next();
  await waitFor(() => queries[0]?.prompts.length === 1);

  await session.interrupt();
  await waitFor(() => queries[0]?.interrupt.mock.calls.length === 1);

  expect(queryFactory).toHaveBeenCalledTimes(1);
  expect(queries[0]?.return).not.toHaveBeenCalled();

  const firstTurnEvents = await collectUntilTerminal(firstTurn);
  expect(firstTurnEvents.find((event) => event.type === "turn_canceled")).toMatchObject({
    type: "turn_canceled",
    provider: "claude",
    reason: "Interrupted",
  });

  await session.close();
});

async function startSteeredTurn(sessionId: string): Promise<{
  session: AgentSession;
  query: () => ScriptedQuery | null;
  turn: AsyncGenerator<AgentStreamEvent>;
}> {
  let query: ScriptedQuery | null = null;
  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    query = createScriptedQuery({ prompt, sessionId });
    return query;
  });

  const session = await new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  }).createSession({ provider: "claude", cwd: process.cwd() });

  const turn = streamSession(session, "original running prompt");
  const start = await turn.next();
  if (!start.value || start.value.type !== "turn_started" || !start.value.turnId) {
    throw new Error("Expected the original Claude turn to start");
  }
  await waitFor(() => query?.prompts.length === 1);

  const steered = await session.steerActiveTurn!("queued steer", {
    expectedTurnId: start.value.turnId,
    clientMessageId: "steer-client",
  });
  expect(steered).toEqual({ status: "accepted" });
  await waitFor(() => query?.prompts.length === 2);

  return { session, query: () => query, turn };
}

test("interrupt discards a queued steer so it cannot resume the stopped turn", async () => {
  const { session, query, turn } = await startSteeredTurn("queued-steer-discard-session");

  await session.interrupt();
  await waitFor(() => query()?.interrupt.mock.calls.length === 1);

  expect(query()?.cancelAsyncMessage).toHaveBeenCalledWith(query()?.prompts[1]?.uuid);
  expect(await collectUntilTerminal(turn)).toContainEqual(
    expect.objectContaining({ type: "turn_canceled" }),
  );

  // Nothing is queued any more, so a second interrupt has no steer left to discard.
  query()?.cancelAsyncMessage.mockClear();
  await session.interrupt();
  await waitFor(() => query()?.interrupt.mock.calls.length === 2);
  expect(query()?.cancelAsyncMessage).not.toHaveBeenCalled();

  await session.close();
});

test("interrupt still stops the turn when Claude has already dequeued the steer", async () => {
  const { session, query, turn } = await startSteeredTurn("queued-steer-declined-session");
  query()?.cancelAsyncMessage.mockResolvedValue(false);

  await session.interrupt();
  await waitFor(() => query()?.interrupt.mock.calls.length === 1);

  expect(query()?.cancelAsyncMessage).toHaveBeenCalledWith(query()?.prompts[1]?.uuid);
  expect(await collectUntilTerminal(turn)).toContainEqual(
    expect.objectContaining({ type: "turn_canceled" }),
  );

  await session.close();
});

test("a steer Claude has already read is no longer discardable on interrupt", async () => {
  const { session, query, turn } = await startSteeredTurn("queued-steer-completed-session");

  query()?.emit({
    type: "command_lifecycle",
    command_uuid: query()?.prompts[1]?.uuid,
    state: "completed",
  });
  // Frames are translated in order, so the marker landing proves the lifecycle frame was read.
  query()?.emit({ type: "assistant", message: { content: "STEER_READ" } });
  await consumeUntil(turn, (event) => collectAssistantText([event]).includes("STEER_READ"));

  await session.interrupt();
  await waitFor(() => query()?.interrupt.mock.calls.length === 1);

  expect(query()?.cancelAsyncMessage).not.toHaveBeenCalled();
  await collectUntilTerminal(turn);
  await session.close();
});

function buildStoppedTaskNotification(sessionId: string) {
  return {
    type: "system",
    subtype: "task_notification",
    uuid: "task-notification-1",
    task_id: "task-slow",
    status: "stopped",
    summary: "Sleep 5 seconds",
    session_id: sessionId,
  };
}

function buildAbortedResult(sessionId: string) {
  return {
    type: "result",
    subtype: "error_during_execution",
    errors: ["Request was aborted."],
    session_id: sessionId,
  };
}

function buildRejectedToolResult(sessionId: string) {
  return {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_slow",
          is_error: true,
          content: "The user doesn't want to proceed with this tool use.",
        },
      ],
    },
    uuid: "rejected-tool-result-1",
    session_id: sessionId,
  };
}

async function startInterruptedToolTurn(sessionId: string): Promise<{
  session: AgentSession;
  query: () => ScriptedQuery | null;
  observed: AgentStreamEvent[];
  canceledIndex: number;
  unsubscribe: () => void;
}> {
  let query: ScriptedQuery | null = null;
  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    query = createScriptedQuery({
      prompt,
      sessionId,
      async handlePrompt({ promptRecord, query: scripted }) {
        if (promptRecord.text !== "run the slow tool") {
          return;
        }
        scripted.emit({
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "toolu_slow", name: "Bash", input: { command: "sleep 5" } },
            ],
          },
          session_id: sessionId,
        });
      },
    });
    return query;
  });

  const session = await new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  }).createSession({ provider: "claude", cwd: process.cwd() });

  const observed: AgentStreamEvent[] = [];
  const unsubscribe = session.subscribe((event) => {
    observed.push(event);
  });

  const turn = streamSession(session, "run the slow tool");
  await turn.next();
  await waitFor(() => query?.prompts.length === 1);

  await session.interrupt();
  await collectUntilTerminal(turn);

  const canceledIndex = observed.findIndex((event) => event.type === "turn_canceled");
  expect(canceledIndex).toBeGreaterThanOrEqual(0);

  return { session, query: () => query, observed, canceledIndex, unsubscribe };
}

/**
 * Claude keeps reporting on the request it was told to kill: the notification for the tool it just
 * stopped, the aborted result, then the tool rejection. None of that is new work, so none of it may
 * put the agent back into a running turn.
 */
test("trailing output from an interrupted request does not start a turn", async () => {
  const sessionId = "interrupt-window-session";
  const { session, query, observed, canceledIndex, unsubscribe } =
    await startInterruptedToolTurn(sessionId);

  query()?.emit(buildStoppedTaskNotification(sessionId));
  query()?.emit(buildAbortedResult(sessionId));
  query()?.emit(buildRejectedToolResult(sessionId));

  // Frames are translated in order, so the rejection landing proves the two before it were read.
  await waitFor(() =>
    observed.some(
      (event) =>
        event.type === "timeline" &&
        event.item.type === "tool_call" &&
        event.item.callId === "toolu_slow" &&
        event.item.status === "failed",
    ),
  );
  unsubscribe();

  expect(
    observed.slice(canceledIndex + 1).filter((event) => event.type === "turn_started"),
  ).toEqual([]);

  await session.close();
});

test("Claude can still wake into an autonomous turn once the interrupted request has settled", async () => {
  const sessionId = "interrupt-window-then-wake-session";
  const { session, query, observed, canceledIndex, unsubscribe } =
    await startInterruptedToolTurn(sessionId);

  query()?.emit(buildStoppedTaskNotification(sessionId));
  query()?.emit(buildAbortedResult(sessionId));
  query()?.emit({
    type: "assistant",
    message: { content: "AUTONOMOUS_WAKE_RESPONSE" },
    session_id: sessionId,
  });
  query()?.emit(buildSuccessResult(sessionId));

  await waitFor(() =>
    observed.slice(canceledIndex + 1).some((event) => event.type === "turn_completed"),
  );
  unsubscribe();

  const afterCancel = observed.slice(canceledIndex + 1);
  expect(afterCancel.filter((event) => event.type === "turn_started")).toHaveLength(1);
  expect(collectAssistantText(afterCancel)).toContain("AUTONOMOUS_WAKE_RESPONSE");

  await session.close();
});

test("reuses the existing query after interrupt before starting the next prompt", async () => {
  const logger = createTestLogger();
  const queries: ScriptedQuery[] = [];

  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const scriptedQuery = createScriptedQuery({
      prompt,
      sessionId: "interrupt-reuse-query-session",
      async handlePrompt({ promptRecord, query }) {
        if (promptRecord.text !== "second prompt") {
          return;
        }
        query.emit({
          type: "assistant",
          message: { content: "SECOND_PROMPT_RESPONSE" },
          session_id: "interrupt-reuse-query-session",
        });
        query.emit(buildSuccessResult("interrupt-reuse-query-session"));
      },
    });
    queries.push(scriptedQuery);
    return scriptedQuery;
  });

  const client = new ClaudeAgentClient({
    logger,
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });

  const firstTurn = streamSession(session, "first prompt");
  await firstTurn.next();
  await waitFor(() => queries[0]?.prompts.length === 1);

  await session.interrupt();
  await collectUntilTerminal(firstTurn);

  const secondTurnEvents = await collectUntilTerminal(streamSession(session, "second prompt"));

  expect(queryFactory).toHaveBeenCalledTimes(1);
  expect(queries[0]?.prompts.map((prompt) => prompt.text)).toEqual([
    "first prompt",
    "second prompt",
  ]);
  expect(queries[0]?.interrupt).toHaveBeenCalledTimes(1);
  expect(queries[0]?.return).not.toHaveBeenCalled();
  expect(collectAssistantText(secondTurnEvents)).toContain("SECOND_PROMPT_RESPONSE");

  await session.close();
});

test("emits an assistant system notice when Claude changes session id mid-turn", async () => {
  const logger = createTestLogger();
  let queryRef: ScriptedQuery | null = null;

  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    queryRef = createScriptedQuery({
      prompt,
      sessionId: "claude-original-session",
      async handlePrompt({ promptRecord, query }) {
        if (promptRecord.text !== "trigger session switch") {
          return;
        }
        query.emit({
          type: "assistant",
          message: { content: "Claude kept working." },
          session_id: "claude-provider-switched-session",
        });
        query.emit(buildSuccessResult("claude-provider-switched-session"));
      },
    });
    return queryRef;
  });

  const client = new ClaudeAgentClient({
    logger,
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });

  const events = await collectUntilTerminal(streamSession(session, "trigger session switch"));
  const assistantMessages = events.flatMap((event) => {
    if (event.type !== "timeline" || event.item.type !== "assistant_message") {
      return [];
    }
    return [event.item.text];
  });

  expect(session.id).toBe("claude-provider-switched-session");
  expect(assistantMessages).toContain("Claude kept working.");
  expect(assistantMessages).toContain(
    "Claude switched to a new session: claude-original-session -> claude-provider-switched-session",
  );

  await session.close();
});

test("recovers when the query pump sees a single interrupt abort before the next prompt", async () => {
  const logger = createTestLogger();
  const output = createAsyncQueue<Record<string, unknown>>();
  const prompts: PromptRecord[] = [];
  let throwAbortOnNext = false;

  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const scriptedQuery = {
      next: vi.fn(async () => {
        if (throwAbortOnNext) {
          throwAbortOnNext = false;
          throw new Error("Request was aborted.");
        }
        return output.next();
      }),
      interrupt: vi.fn(async () => {
        throwAbortOnNext = true;
      }),
      return: vi.fn(async () => {
        output.end();
      }),
      setPermissionMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
      supportedCommands: vi.fn(async () => []),
      rewindFiles: vi.fn(async () => ({ canRewind: true })),
      emit: (message: Record<string, unknown>) => {
        output.push(message);
      },
      end: () => {
        output.end();
      },
      prompts,
      [Symbol.asyncIterator]() {
        return this;
      },
    } satisfies ScriptedQuery;

    scriptedQuery.emit({
      type: "system",
      subtype: "init",
      session_id: "interrupt-abort-recovery-session",
      permissionMode: "default",
      model: "opus",
    });

    void (async () => {
      for await (const promptMessage of prompt) {
        const record = promptMessage as Record<string, unknown>;
        const promptRecord = {
          text: extractPromptText(record),
          uuid: typeof record.uuid === "string" ? record.uuid : null,
        };
        prompts.push(promptRecord);

        if (promptRecord.text !== "second prompt") {
          continue;
        }

        output.push({
          type: "assistant",
          message: { content: "SECOND_PROMPT_RESPONSE" },
          session_id: "interrupt-abort-recovery-session",
        });
        output.push(buildSuccessResult("interrupt-abort-recovery-session"));
      }
    })();

    return scriptedQuery;
  });

  const client = new ClaudeAgentClient({
    logger,
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });

  const firstTurn = streamSession(session, "first prompt");
  await firstTurn.next();
  await session.interrupt();
  await collectUntilTerminal(firstTurn);

  const secondTurnEvents = await collectUntilTerminal(streamSession(session, "second prompt"));

  expect(queryFactory).toHaveBeenCalledTimes(1);
  expect(prompts.map((prompt) => prompt.text)).toEqual(["first prompt", "second prompt"]);
  expect(collectAssistantText(secondTurnEvents)).toContain("SECOND_PROMPT_RESPONSE");
  expect(secondTurnEvents.some((event) => event.type === "turn_completed")).toBe(true);

  await session.close();
});

test("stale abort result after replacement start does not poison the new foreground turn", async () => {
  const logger = createTestLogger();
  let queryRef: ScriptedQuery | null = null;

  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    queryRef = createScriptedQuery({
      prompt,
      sessionId: "interrupt-stale-result-session",
    });
    return queryRef;
  });

  const client = new ClaudeAgentClient({
    logger,
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });

  const firstTurn = streamSession(session, "first prompt");
  const firstStarted = await firstTurn.next();
  await waitFor(() => queryRef?.prompts.length === 1);

  await session.interrupt();
  const firstTurnEvents = [firstStarted.value!, ...(await collectUntilTerminal(firstTurn))];
  expect(firstTurnEvents.some((event) => event.type === "turn_canceled")).toBe(true);

  const observedSecondTurnEvents: AgentStreamEvent[] = [];
  const unsubscribe = session.subscribe((event) => {
    observedSecondTurnEvents.push(event);
  });

  const secondTurn = streamSession(session, "second prompt");
  const secondStarted = await secondTurn.next();
  await waitFor(() => queryRef?.prompts.length === 2);

  queryRef?.emit({
    type: "result",
    subtype: "error_during_execution",
    errors: ["Request was aborted."],
    session_id: "interrupt-stale-result-session",
  });
  queryRef?.emit({
    type: "assistant",
    message: { content: "SECOND_PROMPT_RESPONSE" },
    session_id: "interrupt-stale-result-session",
  });
  queryRef?.emit(buildSuccessResult("interrupt-stale-result-session"));

  const secondTurnEvents = [secondStarted.value!, ...(await collectUntilTerminal(secondTurn))];
  unsubscribe();

  expect(secondTurnEvents.some((event) => event.type === "turn_failed")).toBe(false);
  expect(secondTurnEvents.some((event) => event.type === "turn_canceled")).toBe(false);
  expect(secondTurnEvents.some((event) => event.type === "turn_completed")).toBe(true);
  expect(collectAssistantText(secondTurnEvents)).toContain("SECOND_PROMPT_RESPONSE");
  expect(observedSecondTurnEvents.filter((event) => event.type === "turn_started").length).toBe(1);
  expect(
    observedSecondTurnEvents.some(
      (event) => event.type === "turn_failed" || event.type === "turn_canceled",
    ),
  ).toBe(false);

  await session.close();
});

test("creates an autonomous live turn when assistant output arrives without a foreground run", async () => {
  const logger = createTestLogger();
  let queryRef: ScriptedQuery | null = null;

  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    queryRef = createScriptedQuery({
      prompt,
      sessionId: "autonomous-live-session",
      async handlePrompt({ promptRecord, query }) {
        if (promptRecord.text !== "seed prompt") {
          return;
        }
        query.emit({
          type: "assistant",
          message: { content: "SEED_RESPONSE" },
          session_id: "autonomous-live-session",
        });
        query.emit(buildSuccessResult("autonomous-live-session"));
      },
    });
    return queryRef;
  });

  const client = new ClaudeAgentClient({
    logger,
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });

  await collectUntilTerminal(streamSession(session, "seed prompt"));

  const subscribedEvents = subscribeToEvents(session);
  queryRef?.emit({
    type: "assistant",
    message: { content: "AUTONOMOUS_WAKE_RESPONSE" },
    session_id: "autonomous-live-session",
  });
  queryRef?.emit(buildSuccessResult("autonomous-live-session"));

  const started = await subscribedEvents.next();
  const timeline = await subscribedEvents.next();
  const completed = await subscribedEvents.next();

  expect(started.value).toMatchObject({ type: "turn_started", provider: "claude" });
  expect(timeline.value).toMatchObject({
    type: "timeline",
    provider: "claude",
    item: {
      type: "assistant_message",
      text: "AUTONOMOUS_WAKE_RESPONSE",
    },
  });
  expect(completed.value).toMatchObject({
    type: "turn_completed",
    provider: "claude",
  });

  subscribedEvents.close();
  await session.close();
});

test("steers an autonomous turn through its existing query without restarting it", async () => {
  const logger = createTestLogger();
  let queryRef: ScriptedQuery | null = null;

  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    queryRef = createScriptedQuery({
      prompt,
      sessionId: "autonomous-steer-session",
      async handlePrompt({ promptRecord, query }) {
        if (promptRecord.text === "seed prompt") {
          query.emit({
            type: "assistant",
            message: { content: "SEED_RESPONSE" },
            session_id: "autonomous-steer-session",
          });
          query.emit(buildSuccessResult("autonomous-steer-session"));
          return;
        }
        if (promptRecord.text === "steer prompt") {
          query.emit({
            type: "assistant",
            message: { content: "STEERED_RESPONSE" },
            session_id: "autonomous-steer-session",
          });
          query.emit(buildSuccessResult("autonomous-steer-session"));
        }
      },
    });
    return queryRef;
  });

  const session = await new ClaudeAgentClient({
    logger,
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  }).createSession({ provider: "claude", cwd: process.cwd() });

  await collectUntilTerminal(streamSession(session, "seed prompt"));
  const autonomousEvents = subscribeToEvents(session);
  queryRef?.emit({
    type: "assistant",
    message: { content: "AUTONOMOUS_RESPONSE" },
    session_id: "autonomous-steer-session",
  });
  const autonomousStart = await autonomousEvents.next();
  const autonomousTimeline = await autonomousEvents.next();
  const autonomousTurnId = autonomousStart.value?.turnId;
  expect(autonomousTurnId).toBeTruthy();

  const steer = await session.steerActiveTurn!("steer prompt", {
    expectedTurnId: autonomousTurnId!,
    clientMessageId: "steer-client",
  });
  const steeredTimeline = await autonomousEvents.next();
  const completion = await autonomousEvents.next();

  expect(steer).toEqual({ status: "accepted" });
  expect(queryFactory).toHaveBeenCalledTimes(1);
  expect(queryRef?.interrupt).not.toHaveBeenCalled();
  expect(queryRef?.prompts.map((prompt) => prompt.text)).toEqual(["seed prompt", "steer prompt"]);
  expect(autonomousTimeline.value).toMatchObject({ turnId: autonomousTurnId });
  expect(steeredTimeline.value).toMatchObject({
    type: "timeline",
    turnId: autonomousTurnId,
    item: { type: "assistant_message", text: "STEERED_RESPONSE" },
  });
  expect(completion.value).toMatchObject({ type: "turn_completed", turnId: autonomousTurnId });
  expect(
    [autonomousStart.value, autonomousTimeline.value, steeredTimeline.value, completion.value].map(
      (event) => event?.turnId,
    ),
  ).toEqual([autonomousTurnId, autonomousTurnId, autonomousTurnId, autonomousTurnId]);

  autonomousEvents.close();
  await session.close();
});

test("auto-completes an open autonomous turn when a foreground prompt starts", async () => {
  const logger = createTestLogger();
  let queryRef: ScriptedQuery | null = null;

  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    queryRef = createScriptedQuery({
      prompt,
      sessionId: "autonomous-handoff-session",
      async handlePrompt({ promptRecord, query }) {
        if (promptRecord.text === "seed prompt") {
          query.emit({
            type: "assistant",
            message: { content: "SEED_RESPONSE" },
            session_id: "autonomous-handoff-session",
          });
          query.emit(buildSuccessResult("autonomous-handoff-session"));
          return;
        }

        if (promptRecord.text === "foreground prompt") {
          query.emit({
            type: "assistant",
            message: { content: "FOREGROUND_RESPONSE" },
            session_id: "autonomous-handoff-session",
          });
          query.emit(buildSuccessResult("autonomous-handoff-session"));
        }
      },
    });
    return queryRef;
  });

  const client = new ClaudeAgentClient({
    logger,
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
  });

  await collectUntilTerminal(streamSession(session, "seed prompt"));

  const subscribedEvents = subscribeToEvents(session);
  queryRef?.emit({
    type: "assistant",
    message: { content: "BACKGROUND_ONLY_RESPONSE" },
    session_id: "autonomous-handoff-session",
  });

  const autonomousStart = await subscribedEvents.next();
  const autonomousTimeline = await subscribedEvents.next();
  const foregroundEvents = await collectUntilTerminal(streamSession(session, "foreground prompt"));
  const autonomousComplete = await subscribedEvents.next();

  expect(autonomousStart.value).toMatchObject({
    type: "turn_started",
    provider: "claude",
  });
  expect(autonomousTimeline.value).toMatchObject({
    type: "timeline",
    provider: "claude",
    item: {
      type: "assistant_message",
      text: "BACKGROUND_ONLY_RESPONSE",
    },
  });
  expect(autonomousComplete.value).toMatchObject({
    type: "turn_completed",
    provider: "claude",
  });
  expect(foregroundEvents.some((event) => event.type === "turn_completed")).toBe(true);
  expect(collectAssistantText(foregroundEvents)).toContain("FOREGROUND_RESPONSE");
  expect(
    [autonomousStart.value, autonomousTimeline.value, autonomousComplete.value].some(
      (event) => event?.type === "turn_canceled",
    ),
  ).toBe(false);
  expect(queryFactory).toHaveBeenCalledTimes(1);
  expect(queryRef?.prompts.map((prompt) => prompt.text)).toEqual([
    "seed prompt",
    "foreground prompt",
  ]);

  subscribedEvents.close();
  await session.close();
});

/**
 * An interrupted compaction never reaches `appendResultEvents` — the aborted result is suppressed
 * as stale — so the marker has to be terminalized on the cancel path itself. Leaving it open is
 * worse than the spinner it replaced: the flag that suppresses duplicate markers would then
 * silently swallow the NEXT real compaction's marker.
 */
test("interrupting a compaction closes its marker and leaves the next compaction visible", async () => {
  const sessionId = "compaction-interrupt-session";
  let query: ScriptedQuery | null = null;
  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    query = createScriptedQuery({
      prompt,
      sessionId,
      async handlePrompt({ query: scripted }) {
        scripted.emit({
          type: "system",
          subtype: "status",
          status: "compacting",
          session_id: sessionId,
        });
      },
    });
    return query;
  });

  const session = await new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  }).createSession({ provider: "claude", cwd: process.cwd() });

  const observed: AgentStreamEvent[] = [];
  const unsubscribe = session.subscribe((event) => {
    observed.push(event);
  });

  const turn = streamSession(session, "compact this");
  await turn.next();
  await waitFor(() =>
    observed.some(
      (event) =>
        event.type === "timeline" &&
        event.item.type === "compaction" &&
        event.item.status === "loading",
    ),
  );

  await session.interrupt();
  await collectUntilTerminal(turn);
  query?.emit(buildAbortedResult(sessionId));

  const canceledIndex = observed.findIndex((event) => event.type === "turn_canceled");
  expect(canceledIndex).toBeGreaterThanOrEqual(0);
  const closedIndex = observed.findIndex(
    (event) =>
      event.type === "timeline" &&
      event.item.type === "compaction" &&
      event.item.status === "completed",
  );
  expect(closedIndex).toBeGreaterThanOrEqual(0);
  expect(closedIndex).toBeLessThan(canceledIndex);

  // The next compaction must still announce itself.
  query?.emit({
    type: "system",
    subtype: "status",
    status: "compacting",
    session_id: sessionId,
  });
  await waitFor(
    () =>
      observed.filter(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "compaction" &&
          event.item.status === "loading",
      ).length === 2,
  );

  unsubscribe();
  await session.close();
});

const COMPACT_SUMMARY_TEXT =
  "This session is being continued from a previous conversation that ran out of context. " +
  "The summary below covers the earlier portion of the conversation.";

function buildCompactingStatus(sessionId: string) {
  return { type: "system", subtype: "status", status: "compacting", session_id: sessionId };
}

function buildCompactBoundary(sessionId: string) {
  return {
    type: "system",
    subtype: "compact_boundary",
    uuid: "compact-boundary-1",
    compact_metadata: { trigger: "manual", pre_tokens: 120_000 },
    session_id: sessionId,
  };
}

/** The summary as the CLI streams it: its SDK serializer sets `isSynthetic` for a compact summary. */
function buildStreamedCompactSummary(sessionId: string) {
  return {
    type: "user",
    uuid: "compact-summary-1",
    parent_tool_use_id: null,
    isSynthetic: true,
    message: { role: "user", content: COMPACT_SUMMARY_TEXT },
    session_id: sessionId,
  };
}

function compactionItems(
  items: AgentTimelineItem[],
): Array<Extract<AgentTimelineItem, { type: "compaction" }>> {
  return items.filter(
    (item): item is Extract<AgentTimelineItem, { type: "compaction" }> =>
      item.type === "compaction",
  );
}

function userMessageTexts(items: AgentTimelineItem[]): string[] {
  return items.flatMap((item) => (item.type === "user_message" ? [item.text] : []));
}

interface ClaudeManagerScenario {
  manager: AgentManager;
  agentId: string;
  query: () => ScriptedQuery;
  timeline: () => AgentTimelineItem[];
  cleanup: () => Promise<void>;
}

/** The real AgentManager and prompt dispatcher driving a Claude session over a scripted query. */
async function startClaudeManagerScenario(
  sessionId: string,
  handlePrompt: PromptHandler,
): Promise<ClaudeManagerScenario> {
  let query: ScriptedQuery | null = null;
  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    query = createScriptedQuery({ prompt, sessionId, handlePrompt });
    return query;
  });
  const logger = createTestLogger();
  const manager = new AgentManager({
    clients: {
      claude: new ClaudeAgentClient({
        logger,
        queryFactory,
        resolveBinary: async () => "/test/claude/bin",
      }),
    },
    logger,
  });
  const events: AgentManagerEvent[] = [];
  const unsubscribe = manager.subscribe((event) => events.push(event), { replayState: false });
  const agent = await manager.createAgent({ provider: "claude", cwd: process.cwd() }, undefined, {
    workspaceId: undefined,
  });
  return {
    manager,
    agentId: agent.id,
    query: () => {
      if (!query) throw new Error("Claude query has not started");
      return query;
    },
    timeline: () =>
      events.flatMap((event) =>
        event.type === "agent_stream" && event.event.type === "timeline" ? [event.event.item] : [],
      ),
    cleanup: async () => {
      if (manager.getAgent(agent.id)) {
        await manager.closeAgent(agent.id);
      }
      unsubscribe();
    },
  };
}

function sendClaudePrompt(
  scenario: ClaudeManagerScenario,
  text: string,
  activeTurnBehavior: "interrupt" | "steer",
): ReturnType<typeof startAgentRun> {
  return startAgentRun(scenario.manager, scenario.agentId, text, createTestLogger(), {
    replaceRunning: true,
    activeTurnBehavior,
    clearPendingPermissions: true,
    runOptions: { clientMessageId: `client-${text.replace(/\W/g, "-")}` },
  });
}

async function settleClaude(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

/**
 * Let the session echo the prompt before the scripted CLI answers it. A real CLI's first status
 * arrives well after that echo; answering synchronously inverts the order, and the old
 * "first user message after compacting" rule then consumed the /compact echo itself, hiding the
 * very leak these tests exist for.
 */
async function afterPromptEcho(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

test.each(["interrupt", "steer"] as const)(
  "a %s prompt sent during Claude /compact waits for the compaction and is delivered once",
  async (activeTurnBehavior) => {
    const sessionId = `compact-hold-${activeTurnBehavior}`;
    const scenario = await startClaudeManagerScenario(
      sessionId,
      async ({ promptRecord, query }) => {
        if (promptRecord.text === "/compact") {
          await afterPromptEcho();
          query.emit(buildCompactingStatus(sessionId));
          return;
        }
        query.emit({
          type: "assistant",
          uuid: `assistant-${promptRecord.text}`,
          message: { role: "assistant", content: [{ type: "text", text: "done" }] },
          session_id: sessionId,
        });
        query.emit(buildSuccessResult(sessionId));
      },
    );
    try {
      const compact = await sendClaudePrompt(scenario, "/compact", activeTurnBehavior);
      expect(compact.disposition).toBe("turn_started");
      await waitFor(() => scenario.manager.isHoldingPromptsForCompaction(scenario.agentId));

      // Not awaited first: the old dispatcher only returned after canceling the compaction.
      const followUp = sendClaudePrompt(scenario, "follow up", activeTurnBehavior);
      await settleClaude();
      // Not interrupted, and not pushed into the live input either: a prompt pushed during the
      // compaction is what the old "first user message after compacting" rule would have eaten.
      expect(scenario.query().interrupt).not.toHaveBeenCalled();
      expect(scenario.query().prompts.map((prompt) => prompt.text)).toEqual(["/compact"]);
      expect((await followUp).disposition).toBe("held");

      scenario.query().emit(buildCompactBoundary(sessionId));
      scenario.query().emit(buildStreamedCompactSummary(sessionId));
      scenario.query().emit(buildSuccessResult(sessionId));

      await waitFor(() => scenario.query().prompts.length === 2);
      await waitFor(() => scenario.manager.getAgent(scenario.agentId)?.lifecycle === "idle");
      await settleClaude();

      expect(scenario.query().prompts.map((prompt) => prompt.text)).toEqual([
        "/compact",
        "follow up",
      ]);
      expect(scenario.query().interrupt).not.toHaveBeenCalled();
      expect(userMessageTexts(scenario.timeline()).filter((text) => text === "follow up")).toEqual([
        "follow up",
      ]);
      expect(userMessageTexts(scenario.timeline())).not.toContain(COMPACT_SUMMARY_TEXT);
      expect(compactionItems(scenario.timeline())).toEqual([
        { type: "compaction", status: "loading" },
        expect.objectContaining({ type: "compaction", status: "completed", trigger: "manual" }),
      ]);
      expect(compactionItems(scenario.timeline())[1]).not.toHaveProperty("outcome");
    } finally {
      await scenario.cleanup();
    }
  },
);

/** The provider has actually opened its compaction marker, not merely been asked to compact. */
async function waitForCompactionMarker(scenario: {
  timeline: () => AgentTimelineItem[];
}): Promise<void> {
  await waitFor(() =>
    compactionItems(scenario.timeline()).some((item) => item.status === "loading"),
  );
}

test("Stop during a Claude compaction never presents it as compacted", async () => {
  const sessionId = "compact-stop";
  const scenario = await startClaudeManagerScenario(sessionId, async ({ promptRecord, query }) => {
    if (promptRecord.text === "/compact") {
      await afterPromptEcho();
      query.emit(buildCompactingStatus(sessionId));
    }
  });
  try {
    await sendClaudePrompt(scenario, "/compact", "interrupt");
    // The manager holds prompts from the moment /compact is dispatched. Wait for the provider's
    // own marker, which is what this test is about.
    await waitForCompactionMarker(scenario);

    await expect(scenario.manager.cancelAgentRun(scenario.agentId)).resolves.toEqual({
      status: "settled",
    });
    scenario.query().emit(buildAbortedResult(sessionId));
    await settleClaude();

    // The spinner terminates, with the honest outcome.
    expect(compactionItems(scenario.timeline())).toEqual([
      { type: "compaction", status: "loading" },
      { type: "compaction", status: "completed", outcome: "canceled" },
    ]);
    expect(scenario.manager.isHoldingPromptsForCompaction(scenario.agentId)).toBe(false);
  } finally {
    await scenario.cleanup();
  }
});

test("after a stopped Claude compaction, a steer into the next running turn is not refused", async () => {
  const sessionId = "compact-stop-then-steer";
  const scenario = await startClaudeManagerScenario(sessionId, async ({ promptRecord, query }) => {
    if (promptRecord.text === "/compact") {
      await afterPromptEcho();
      query.emit(buildCompactingStatus(sessionId));
    }
  });
  try {
    await sendClaudePrompt(scenario, "/compact", "interrupt");
    await waitForCompactionMarker(scenario);
    await scenario.manager.cancelAgentRun(scenario.agentId);
    scenario.query().emit(buildAbortedResult(sessionId));
    await waitFor(() => scenario.manager.getAgent(scenario.agentId)?.lifecycle === "idle");
    const interruptsAfterStop = scenario.query().interrupt.mock.calls.length;

    // Claude wakes on its own (a background task finished, say). No paseo prompt started this
    // turn, so no prompt echo has passed through the old reset: a stuck `compacting` refuses the
    // steer, and the dispatcher replaces the turn instead.
    scenario
      .query()
      .emit({ type: "assistant", message: { content: "WOKE_UP" }, session_id: sessionId });
    await waitFor(() => scenario.manager.getAgent(scenario.agentId)?.lifecycle === "running");

    // Not awaited first: a refused steer replaces the turn, and that waits on the interrupt.
    const steer = sendClaudePrompt(scenario, "mid-turn note", "steer");
    await settleClaude();
    expect(scenario.query().interrupt.mock.calls.length).toBe(interruptsAfterStop);
    expect((await steer).disposition).toBe("steered");
    await waitFor(() => scenario.query().prompts.some((prompt) => prompt.text === "mid-turn note"));

    scenario.query().emit(buildSuccessResult(sessionId));
    await waitFor(() => scenario.manager.getAgent(scenario.agentId)?.lifecycle === "idle");
  } finally {
    await scenario.cleanup();
  }
});

function observedItems(events: AgentStreamEvent[]): AgentTimelineItem[] {
  return events.flatMap((event) => (event.type === "timeline" ? [event.item] : []));
}

function observedUserTexts(events: AgentStreamEvent[]): string[] {
  return userMessageTexts(observedItems(events));
}

/** `/compact`, stopped or completed, then a new prompt, through one Claude session. */
async function compactThenPrompt(
  sessionId: string,
  ending: "stopped" | "completed",
  summary: Record<string, unknown> = buildStreamedCompactSummary(sessionId),
): Promise<AgentStreamEvent[]> {
  let query: ScriptedQuery | null = null;
  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    query = createScriptedQuery({
      prompt,
      sessionId,
      async handlePrompt({ promptRecord, query: scripted }) {
        await afterPromptEcho();
        if (promptRecord.text !== "/compact") {
          scripted.emit(buildSuccessResult(sessionId));
          return;
        }
        scripted.emit(buildCompactingStatus(sessionId));
        if (ending === "completed") {
          scripted.emit(buildCompactBoundary(sessionId));
          scripted.emit(summary);
          scripted.emit(buildSuccessResult(sessionId));
        }
      },
    });
    return query;
  });
  const session = await new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  }).createSession({ provider: "claude", cwd: process.cwd() });
  const observed: AgentStreamEvent[] = [];
  const unsubscribe = session.subscribe((event) => observed.push(event));
  const compactTurn = streamSession(session, "/compact");
  if (ending === "stopped") {
    await compactTurn.next();
    await waitFor(() => compactionItems(observedItems(observed)).length > 0);
    await session.interrupt();
    await collectUntilTerminal(compactTurn);
    query?.emit(buildAbortedResult(sessionId));
  } else {
    await collectUntilTerminal(compactTurn);
  }
  await collectUntilTerminal(streamSession(session, "next task"));
  unsubscribe();
  await session.close();
  return observed;
}

test.each(["stopped", "completed"] as const)(
  "the next prompt after a %s Claude compaction is not swallowed as its summary",
  async (ending) => {
    const observed = await compactThenPrompt(`compact-${ending}-then-prompt`, ending);
    // The CLI streams the summary flagged synthetic, so the old "first user message after
    // compacting" rule never saw it and ate this prompt instead.
    expect(observedUserTexts(observed)).toContain("next task");
    expect(observedUserTexts(observed)).not.toContain(COMPACT_SUMMARY_TEXT);
  },
);

test.each([
  {
    name: "flagged isCompactSummary",
    summary: (sessionId: string) => ({
      ...buildStreamedCompactSummary(sessionId),
      isSynthetic: undefined,
      isCompactSummary: true,
    }),
  },
  {
    name: "unflagged but opening with the summary sentence",
    summary: (sessionId: string) => ({
      ...buildStreamedCompactSummary(sessionId),
      isSynthetic: undefined,
    }),
  },
])("a compaction summary streamed as $name is still not rendered", async ({ summary }) => {
  const sessionId = "compact-summary-shapes";
  const observed = await compactThenPrompt(sessionId, "completed", summary(sessionId));
  expect(observedUserTexts(observed)).not.toContain(COMPACT_SUMMARY_TEXT);
  expect(observedUserTexts(observed)).toContain("next task");
});

test.each([
  { detail: "prompt is too long", expectedErrors: ["Compaction failed: prompt is too long"] },
  { detail: undefined, expectedErrors: [] },
])(
  "a failed Claude compaction closes its marker as failed (detail: $detail)",
  async ({ detail, expectedErrors }) => {
    const sessionId = "compact-result-failed";
    let query: ScriptedQuery | null = null;
    queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      query = createScriptedQuery({
        prompt,
        sessionId,
        async handlePrompt({ query: scripted }) {
          await afterPromptEcho();
          scripted.emit(buildCompactingStatus(sessionId));
          scripted.emit({
            type: "system",
            subtype: "status",
            status: null,
            compact_result: "failed",
            ...(detail ? { compact_error: detail } : {}),
            session_id: sessionId,
          });
          scripted.emit(buildSuccessResult(sessionId));
        },
      });
      return query;
    });
    const session = await new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    }).createSession({ provider: "claude", cwd: process.cwd() });
    const observed: AgentStreamEvent[] = [];
    const unsubscribe = session.subscribe((event) => observed.push(event));
    await collectUntilTerminal(streamSession(session, "/compact"));
    unsubscribe();
    await session.close();

    const items = observed.flatMap((event) => (event.type === "timeline" ? [event.item] : []));
    expect(compactionItems(items)).toEqual([
      { type: "compaction", status: "loading" },
      { type: "compaction", status: "completed", outcome: "failed" },
    ]);
    expect(items.flatMap((item) => (item.type === "error" ? [item.message] : []))).toEqual(
      expectedErrors,
    );
  },
);

/** A genuine user message that happens to open with the summary's fixed sentence. */
function buildSummaryLookalikeUserMessage(sessionId: string, text: string) {
  return {
    type: "user",
    uuid: "lookalike-user-1",
    parent_tool_use_id: null,
    message: { role: "user", content: text },
    session_id: sessionId,
  };
}

test("a real user message opening with the summary sentence survives the synthetic summary", async () => {
  const sessionId = "compact-summary-lookalike";
  const lookalike = `${COMPACT_SUMMARY_TEXT} Now please review the diff.`;
  queryFactory.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) =>
    createScriptedQuery({
      prompt,
      sessionId,
      async handlePrompt({ promptRecord, query: scripted }) {
        await afterPromptEcho();
        if (promptRecord.text !== "/compact") {
          scripted.emit(buildSuccessResult(sessionId));
          return;
        }
        scripted.emit(buildCompactingStatus(sessionId));
        scripted.emit(buildCompactBoundary(sessionId));
        // The CLI's own summary, streamed synthetic. It must disarm the text fallback...
        scripted.emit(buildStreamedCompactSummary(sessionId));
        // ...so this real message, which merely opens the same way, is still rendered.
        scripted.emit(buildSummaryLookalikeUserMessage(sessionId, lookalike));
        scripted.emit(buildSuccessResult(sessionId));
      },
    }),
  );
  const session = await new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  }).createSession({ provider: "claude", cwd: process.cwd() });
  const observed: AgentStreamEvent[] = [];
  const unsubscribe = session.subscribe((event) => observed.push(event));
  try {
    await collectUntilTerminal(streamSession(session, "/compact"));
    await waitFor(() => observedUserTexts(observed).includes(lookalike));

    expect(observedUserTexts(observed)).toContain(lookalike);
    expect(observedUserTexts(observed)).not.toContain(COMPACT_SUMMARY_TEXT);
  } finally {
    unsubscribe();
    await session.close();
  }
});
