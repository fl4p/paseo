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

  test("fails the close while the kill still cannot be confirmed", async () => {
    processTree.captureProcessTree.mockResolvedValue({ processes: new Map() });
    processTree.terminateCapturedProcessTree.mockResolvedValue("kill-timeout");
    const transport = startIdleProcess();

    await expect(transport.terminate()).rejects.toThrow("did not exit after SIGKILL");
    await expect(transport.close()).rejects.toThrow("did not exit after SIGKILL");
  });
});
