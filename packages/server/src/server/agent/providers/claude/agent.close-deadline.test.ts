import type { ChildProcess } from "node:child_process";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { asInternals } from "../../../test-utils/class-mocks.js";
import { ClaudeAgentClient } from "./agent.js";

/**
 * close() runs inside the daemon's 5 s close deadline. Every process enumeration it does may take
 * up to 5 s on its own, so close() needs one deadline across all of them, and a refresh that fails
 * must still end in a kill of the tree it already knows.
 *
 * The deadline tests use a deterministic capture, so they do not depend on `ps` working where they
 * run (where it does not, capture fails and close takes the root-only path, which proves nothing
 * about the tree paths). They assert which paths ran. The last test drives real `ps`.
 */
const tree = vi.hoisted(() => ({
  capture: "real" as "real" | "fixture",
  refresh: "real" as "real" | "fail" | "hang",
  terminate: "real" as "real" | "fixture" | "hang",
  verifiedKill: "real" as "real" | "fixture",
  calls: { capture: [] as string[], refresh: 0, terminate: 0, verifiedKill: 0 },
}));

vi.mock("../../../../utils/process-tree.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../utils/process-tree.js")>();
  const never = () => new Promise<never>(() => {});
  return {
    ...actual,
    captureProcessTree: async (...args: Parameters<typeof actual.captureProcessTree>) => {
      const [pid, groupId] = args;
      if (tree.capture === "fixture") {
        tree.calls.capture.push("ok");
        const root = { pid, parentPid: process.pid, groupId, started: "fixture", zombie: false };
        return { root, groupId, processes: new Map([[pid, root]]) };
      }
      try {
        const snapshot = await actual.captureProcessTree(...args);
        tree.calls.capture.push("ok");
        return snapshot;
      } catch (error) {
        tree.calls.capture.push("error");
        throw error;
      }
    },
    refreshProcessTree: async (snapshot: Parameters<typeof actual.refreshProcessTree>[0]) => {
      tree.calls.refresh += 1;
      if (tree.refresh === "fail") throw new Error("ps failed");
      if (tree.refresh === "hang") return never();
      return actual.refreshProcessTree(snapshot);
    },
    terminateCapturedProcessTree: async (
      ...args: Parameters<typeof actual.terminateCapturedProcessTree>
    ) => {
      tree.calls.terminate += 1;
      if (tree.terminate === "hang") return never();
      if (tree.terminate === "fixture") {
        // Stands in for the orderly kill of the captured tree: its only member is the root.
        process.kill(args[0].root.pid, "SIGKILL");
        return "killed" as const;
      }
      return actual.terminateCapturedProcessTree(...args);
    },
    killVerifiedProcessTree: async (...args: Parameters<typeof actual.killVerifiedProcessTree>) => {
      tree.calls.verifiedKill += 1;
      if (tree.verifiedKill === "fixture") return { killed: [], mismatched: [] };
      return actual.killVerifiedProcessTree(...args);
    },
  };
});

afterEach(() => {
  tree.capture = "real";
  tree.refresh = "real";
  tree.terminate = "real";
  tree.verifiedKill = "real";
  tree.calls = { capture: [], refresh: 0, terminate: 0, verifiedKill: 0 };
});

function createQueryMock(): Query {
  return {
    next: vi.fn(async () => ({ done: true, value: undefined })),
    return: vi.fn(async () => ({ done: true, value: undefined })),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => []),
    supportedCommands: vi.fn(async () => []),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as Query;
}

/** A Claude session whose process ignores SIGTERM and stays up until killed. */
async function startSessionWithStubbornProcess() {
  let spawn: (() => ChildProcess) | undefined;
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => process.execPath,
    queryFactory: ({ options }) => {
      spawn = () =>
        options.spawnClaudeCodeProcess!({
          command: process.execPath,
          args: [
            "-e",
            "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
          ],
          cwd: process.cwd(),
          env: process.env,
          signal: new AbortController().signal,
        }) as ChildProcess;
      return createQueryMock();
    },
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
  await session.listCommands?.();
  if (!spawn) throw new Error("Claude query was not created");
  const child = spawn();
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout!.once("data", () => resolve());
  });
  // The spawn-time capture must have finished, as for a session that has been running.
  await vi.waitFor(() => expect(tree.calls.capture).toHaveLength(1), { timeout: 5_000 });
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  return { session, child, exited };
}

function stillRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function expectClosedInTime(
  session: { close(): Promise<void> },
  child: ChildProcess,
  exited: Promise<void>,
) {
  const started = Date.now();
  await session.close();
  // The daemon gives a close 5 s.
  expect(Date.now() - started).toBeLessThan(4_750);
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  expect(stillRunning(child)).toBe(false);
}

test("close() still kills the captured tree when the refresh fails", async () => {
  tree.capture = "fixture";
  tree.terminate = "fixture";
  const { session, child, exited } = await startSessionWithStubbornProcess();
  try {
    tree.refresh = "fail";
    await expectClosedInTime(session, child, exited);
    expect(tree.calls).toMatchObject({ capture: ["ok"], refresh: 1, terminate: 1 });
  } finally {
    if (stillRunning(child)) child.kill("SIGKILL");
  }
}, 15_000);

test("close() kills the root within its deadline when the refresh and the kill hang", async () => {
  tree.capture = "fixture";
  tree.verifiedKill = "fixture";
  const { session, child, exited } = await startSessionWithStubbornProcess();
  try {
    tree.refresh = "hang";
    tree.terminate = "hang";
    await expectClosedInTime(session, child, exited);
    expect(tree.calls).toMatchObject({
      capture: ["ok"],
      refresh: 1,
      terminate: 1,
      verifiedKill: 1,
    });
  } finally {
    if (stillRunning(child)) child.kill("SIGKILL");
  }
}, 15_000);

test("close() does not let a stalled history load hold the process teardown", async () => {
  tree.capture = "fixture";
  tree.terminate = "fixture";
  const { session, child, exited } = await startSessionWithStubbornProcess();
  let releaseHistory!: () => void;
  asInternals<{ historyReady: Promise<void> | null }>(session).historyReady = new Promise<void>(
    (resolve) => {
      releaseHistory = resolve;
    },
  );
  try {
    await expectClosedInTime(session, child, exited);
    expect(tree.calls).toMatchObject({ capture: ["ok"], terminate: 1 });
  } finally {
    releaseHistory();
    if (stillRunning(child)) child.kill("SIGKILL");
  }
}, 15_000);

test.skipIf(process.platform === "win32")(
  "close() stops a SIGTERM-ignoring process through real process enumeration",
  async () => {
    const { session, child, exited } = await startSessionWithStubbornProcess();
    try {
      expect(tree.calls.capture).toEqual(["ok"]);
      await expectClosedInTime(session, child, exited);
      expect(tree.calls).toMatchObject({ refresh: 1, terminate: 1, verifiedKill: 0 });
    } finally {
      if (stillRunning(child)) child.kill("SIGKILL");
    }
  },
  15_000,
);
