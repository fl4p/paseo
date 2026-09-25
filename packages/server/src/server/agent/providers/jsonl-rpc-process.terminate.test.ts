import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

// A real SIGKILL cannot be made to fail, so the process-tree kill is scripted here; the real
// tree behaviour is covered in jsonl-rpc-process.test.ts.
const processTree = vi.hoisted(() => ({
  captureProcessTree: vi.fn(),
  terminateCapturedProcessTree: vi.fn(),
}));
vi.mock("../../../utils/process-tree.js", () => processTree);

import { JsonlRpcProcess } from "./jsonl-rpc-process.js";

const children: ChildProcessWithoutNullStreams[] = [];

// Root in its own group, with a grandchild that ignores SIGTERM and reports its pid once ready.
const GROUP_WITH_STUBBORN_GRANDCHILD = String.raw`
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const grandchild = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000);",
], { stdio: ["ignore", "pipe", "ignore"] });
readline.createInterface({ input: grandchild.stdout }).on("line", (line) => {
  process.stdout.write(JSON.stringify({ type: "grandchild", pid: Number(line) }) + "\n");
});
setInterval(() => {}, 1000);
`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startIdleProcess(): JsonlRpcProcess {
  return new JsonlRpcProcess({
    launch: { command: process.execPath, args: [], cwd: process.cwd() },
    logger: pino({ level: "silent" }),
    spawn: () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.push(child);
      return child;
    },
  });
}

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  vi.clearAllMocks();
});

describe("JsonlRpcProcess close after an unconfirmed terminate", () => {
  test("retries the kill instead of reporting a disposed transport as closed", async () => {
    processTree.captureProcessTree.mockResolvedValue({ processes: new Map() });
    processTree.terminateCapturedProcessTree
      .mockResolvedValueOnce("kill-timeout")
      .mockResolvedValueOnce("killed");
    const transport = startIdleProcess();

    await expect(transport.terminate()).rejects.toThrow("did not exit after SIGKILL");
    await expect(transport.close()).resolves.toBeUndefined();
    await expect(transport.close()).resolves.toBeUndefined();

    expect(processTree.terminateCapturedProcessTree).toHaveBeenCalledTimes(2);
  });

  test.skipIf(process.platform === "win32")(
    "kills the process group when the tree cannot be captured, and close then confirms",
    async () => {
      processTree.captureProcessTree.mockRejectedValue(new Error("ps timed out"));
      const transport = new JsonlRpcProcess({
        launch: { command: process.execPath, args: [], cwd: process.cwd(), ownProcessGroup: true },
        logger: pino({ level: "silent" }),
        spawn: () => {
          const child = spawn(process.execPath, ["-e", GROUP_WITH_STUBBORN_GRANDCHILD], {
            stdio: ["pipe", "pipe", "pipe"],
            detached: true,
          });
          children.push(child);
          return child;
        },
      });
      const grandchild = await new Promise<number>((resolve) => {
        const unsubscribe = transport.onMessage((message) => {
          if (message.type === "grandchild" && typeof message.pid === "number") {
            unsubscribe();
            resolve(message.pid);
          }
        });
      });
      const kill = vi.spyOn(process, "kill");
      try {
        await expect(transport.terminate()).resolves.toBeUndefined();
        expect(isAlive(grandchild)).toBe(false);
        // One SIGKILL while the group id is certainly pi's; only harmless probes after it.
        const groupSignals = kill.mock.calls.filter(([pid]) => pid < 0).map(([, signal]) => signal);
        expect(groupSignals[0]).toBe("SIGKILL");
        expect(groupSignals.slice(1).every((signal) => signal === 0)).toBe(true);
        await expect(transport.close()).resolves.toBeUndefined();
        expect(processTree.terminateCapturedProcessTree).not.toHaveBeenCalled();
      } finally {
        kill.mockRestore();
        if (isAlive(grandchild)) process.kill(grandchild, "SIGKILL");
      }
    },
    20_000,
  );

  test("fails the close while the kill still cannot be confirmed", async () => {
    processTree.captureProcessTree.mockResolvedValue({ processes: new Map() });
    processTree.terminateCapturedProcessTree.mockResolvedValue("kill-timeout");
    const transport = startIdleProcess();

    await expect(transport.terminate()).rejects.toThrow("did not exit after SIGKILL");
    await expect(transport.close()).rejects.toThrow("did not exit after SIGKILL");
  });
});
