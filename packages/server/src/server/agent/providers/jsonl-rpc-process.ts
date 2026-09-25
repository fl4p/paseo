import { type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "pino";

import { spawnProcess } from "../../../utils/spawn.js";
import {
  captureProcessTree,
  terminateCapturedProcessTree,
  type ProcessTreeSnapshot,
} from "../../../utils/process-tree.js";
import { terminateWithTreeKill } from "../../../utils/tree-kill.js";
import { JsonlFrameDecoder } from "./jsonl-frame-decoder.js";
export { supportsJsonlRpcProtocolV2 } from "./jsonl-frame-decoder.js";

/** Default wall-clock timeout for control-plane / short RPC calls. */
export const JSONL_RPC_DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Pass as `timeoutMs` to wait only for a response, process death, or `close()`.
 * Use for long-running blocking RPCs (e.g. LLM-backed compact).
 */
export const JSONL_RPC_NO_TIMEOUT = null;

const STDERR_BUFFER_LIMIT = 8192;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2_000;
const FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;

export interface JsonlRpcLaunch {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /**
   * Start the process as the leader of its own process group, and capture its tree at spawn, so
   * terminate() also reaches descendants that are reparented before or during the kill (a
   * double fork, a child spawned from a SIGTERM handler). Ignored on Windows.
   */
  ownProcessGroup?: boolean;
}

interface JsonlRpcResponse {
  type: "response";
  id?: string;
  command?: string;
  success?: boolean;
  data?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

export interface JsonlRpcExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error;
}

export interface JsonlRpcProcessOptions {
  launch: JsonlRpcLaunch;
  logger: Logger;
  diagnosticName?: string;
  defaultRequestTimeoutMs?: number;
  spawn?: (launch: JsonlRpcLaunch) => ChildProcessWithoutNullStreams;
}

function assertChildWithPipes(
  child: ChildProcess,
): asserts child is ChildProcessWithoutNullStreams {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("JSONL RPC process was spawned without stdio streams");
  }
}

function spawnJsonlRpcProcess(launch: JsonlRpcLaunch): ChildProcessWithoutNullStreams {
  const child = spawnProcess(launch.command, launch.args, {
    cwd: launch.cwd,
    envOverlay: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: launch.ownProcessGroup === true && process.platform !== "win32",
  });
  assertChildWithPipes(child);
  return child;
}

export class JsonlRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly diagnosticName: string;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly messageSubscribers = new Set<(message: Record<string, unknown>) => void>();
  private readonly exitSubscribers = new Set<(exit: JsonlRpcExit) => void>();
  private stderrBuffer = "";
  private nextRequestId = 1;
  private disposed = false;
  private terminationTree: Promise<ProcessTreeSnapshot> | null = null;
  private terminationAttempted = false;
  private terminationConfirmed = false;
  private spawnTreeCapture: Promise<ProcessTreeSnapshot> | null = null;
  private processGroupId: number | undefined;
  private readonly frameDecoder: JsonlFrameDecoder;

  constructor(private readonly options: JsonlRpcProcessOptions) {
    this.diagnosticName = options.diagnosticName ?? "JSONL RPC";
    this.frameDecoder = new JsonlFrameDecoder({
      frame: (message) => this.dispatchFrame(message),
      problem: (problem, detail) => {
        this.options.logger.warn(
          { problem, detail },
          `Ignoring invalid ${this.diagnosticName} frame`,
        );
      },
    });
    this.child = (options.spawn ?? spawnJsonlRpcProcess)(options.launch);
    const pid = this.child.pid;
    if (options.launch.ownProcessGroup && pid !== undefined) {
      // Kept apart from the capture, so a retry after a failed capture still covers the group.
      this.processGroupId = process.platform === "win32" ? undefined : pid;
      this.spawnTreeCapture = captureProcessTree(pid, this.processGroupId);
      // A capture failure must reach terminate(), never an unhandled rejection.
      void this.spawnTreeCapture.catch(() => undefined);
    }
    this.child.stdout.on("data", (chunk) => {
      this.handleStdoutChunk(chunk.toString());
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderrBuffer += chunk.toString();
      if (this.stderrBuffer.length > STDERR_BUFFER_LIMIT) {
        this.stderrBuffer = this.stderrBuffer.slice(-STDERR_BUFFER_LIMIT);
      }
    });
    this.child.stdin.on("error", (error) => {
      this.handleStdinError(error);
    });
    this.child.on("error", (error) => {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    });
    this.child.on("exit", (code, signal) => {
      const error = new Error(
        `${this.diagnosticName} process exited with code ${code ?? "null"} and signal ${signal ?? "null"}\n${this.stderrBuffer}`.trim(),
      );
      const exit = { code, signal, error };
      for (const subscriber of this.exitSubscribers) {
        subscriber(exit);
      }
      this.failAll(error);
    });
  }

  onMessage(callback: (message: Record<string, unknown>) => void): () => void {
    this.messageSubscribers.add(callback);
    return () => {
      this.messageSubscribers.delete(callback);
    };
  }

  onExit(callback: (exit: JsonlRpcExit) => void): () => void {
    this.exitSubscribers.add(callback);
    return () => {
      this.exitSubscribers.delete(callback);
    };
  }

  startRequest(
    command: { type: string; [key: string]: unknown },
    timeoutMs?: number | null,
  ): { id: string; promise: Promise<unknown> } {
    if (this.disposed) {
      return {
        id: "",
        promise: Promise.reject(new Error(`${this.diagnosticName} process is closed`)),
      };
    }
    const id = `req_${this.nextRequestId}`;
    this.nextRequestId += 1;
    const requestTimeoutMs =
      timeoutMs === undefined
        ? (this.options.defaultRequestTimeoutMs ?? JSONL_RPC_DEFAULT_TIMEOUT_MS)
        : timeoutMs;
    const startedAt = Date.now();
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = createRequestTimeout(requestTimeoutMs, () => {
        this.pending.delete(id);
        reject(
          new Error(
            `${this.diagnosticName} request timed out phase=${command.type} elapsedMs=${Date.now() - startedAt} timeoutMs=${requestTimeoutMs}\n${this.stderrBuffer}`.trim(),
          ),
        );
      });
      this.pending.set(id, { resolve, reject, timer });
      this.send({ ...command, id });
    });
    return { id, promise };
  }

  request(
    command: { type: string; [key: string]: unknown },
    timeoutMs?: number | null,
  ): Promise<unknown> {
    return this.startRequest(command, timeoutMs).promise;
  }

  send(message: Record<string, unknown>): void {
    if (this.disposed) {
      return;
    }
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      this.handleStdinError(new Error(`${this.diagnosticName} stdin is not writable`));
      return;
    }
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.handleStdinError(error);
    }
  }

  async close(error = new Error(`${this.diagnosticName} process is closed`)): Promise<void> {
    if (this.terminationAttempted && !this.terminationConfirmed) {
      // A terminate() that could not confirm the kill already disposed the transport; closing must
      // not report success over it. Retry the same kill, and fail the close if it still cannot.
      await this.terminate(error);
      return;
    }
    if (this.disposed) return;
    this.failAll(error);
    try {
      this.child.stdin.end();
    } catch {
      // Ignore cleanup races.
    }
    const result = await terminateWithTreeKill(this.child, {
      gracefulTimeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      forceTimeoutMs: FORCE_SHUTDOWN_TIMEOUT_MS,
      onForceSignal: () => {
        this.options.logger.warn(
          { timeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS },
          `${this.diagnosticName} process did not exit after SIGTERM; sending SIGKILL`,
        );
      },
    });
    if (result === "kill-timeout") {
      this.options.logger.warn(
        { timeoutMs: FORCE_SHUTDOWN_TIMEOUT_MS },
        `${this.diagnosticName} process did not report exit after SIGKILL`,
      );
    }
  }

  /**
   * Kill the process and its descendants, and confirm they are gone. Unlike close(), root exit is
   * not taken as proof: a tool or MCP server that ignores SIGTERM outlives the root and is
   * reparented, so the tree is captured first and each captured process is tracked to its death.
   * Rejects when that cannot be confirmed; the captured tree is kept, so a retry resumes the kill.
   *
   * Covered: every process still in the parent chain, and with ownProcessGroup every process in
   * the group, including ones orphaned by a double fork. Not covered: a process that left the
   * group with setsid() (a deliberately daemonized server) after reparenting, and, on Windows,
   * anything outside the live parent chain. A shell killing the job would miss those too.
   */
  async terminate(
    error = new Error(`${this.diagnosticName} process was terminated`),
  ): Promise<void> {
    this.terminationAttempted = true;
    this.terminationTree ??= this.spawnTreeCapture ?? this.captureTerminationTree();
    let tree: ProcessTreeSnapshot;
    try {
      tree = await this.terminationTree;
    } catch (captureError) {
      this.terminationTree = null;
      this.spawnTreeCapture = null;
      if (this.processGroupId === undefined) throw captureError;
      await this.terminateProcessGroupWithoutCapture(this.processGroupId, error, captureError);
      this.terminationConfirmed = true;
      return;
    }
    this.failAll(error);
    try {
      this.child.stdin.end();
    } catch {
      // Ignore cleanup races.
    }
    const result = await terminateCapturedProcessTree(tree, {
      gracefulTimeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      forceTimeoutMs: FORCE_SHUTDOWN_TIMEOUT_MS,
      onForceSignal: () => {
        this.options.logger.warn(
          { timeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS },
          `${this.diagnosticName} process tree did not exit after SIGTERM; sending SIGKILL`,
        );
      },
    });
    if (result === "kill-timeout") {
      throw new Error(`${this.diagnosticName} process tree did not exit after SIGKILL`);
    }
    this.terminationConfirmed = true;
  }

  /**
   * The tree could not be read, but the process group is still ours to judge. While the root is
   * alive (or an unreaped zombie) its pid is the group id and cannot be reused, so the group gets
   * one SIGKILL, sent only then. SIGKILL cannot be caught, so after it the group is only probed
   * with signal 0 until it is empty: a probe cannot harm a group that reused the id after ours
   * emptied, and an occupied group stays unconfirmed.
   */
  private async terminateProcessGroupWithoutCapture(
    groupId: number,
    error: Error,
    captureError: unknown,
  ): Promise<void> {
    const rootUnreaped = this.child.exitCode === null && this.child.signalCode === null;
    this.failAll(error);
    const deadline = Date.now() + GRACEFUL_SHUTDOWN_TIMEOUT_MS + FORCE_SHUTDOWN_TIMEOUT_MS;
    let signal: NodeJS.Signals | 0 = rootUnreaped ? "SIGKILL" : 0;
    for (;;) {
      try {
        process.kill(-groupId, signal);
      } catch (killError) {
        if ((killError as NodeJS.ErrnoException).code === "ESRCH") return;
        throw killError;
      }
      signal = 0;
      if (Date.now() >= deadline) {
        throw new Error(
          `${this.diagnosticName} process group ${groupId} could not be confirmed empty`,
          { cause: captureError },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async captureTerminationTree(): Promise<ProcessTreeSnapshot> {
    const pid = this.child.pid;
    if (pid === undefined || this.child.exitCode !== null || this.child.signalCode !== null) {
      throw new Error(
        `${this.diagnosticName} process already exited; its descendants cannot be identified`,
      );
    }
    try {
      return await captureProcessTree(pid, this.processGroupId);
    } catch (error) {
      throw new Error(`Cannot capture the ${this.diagnosticName} process tree`, { cause: error });
    }
  }

  private handleStdoutChunk(chunk: string): void {
    this.frameDecoder.write(chunk);
  }

  /** Route a complete logical frame to its consumer (response or subscriber). */
  private dispatchFrame(message: Record<string, unknown>): void {
    if (message.type === "response") {
      this.handleResponse(message as unknown as JsonlRpcResponse);
      return;
    }
    for (const subscriber of this.messageSubscribers) {
      subscriber(message);
    }
  }

  private handleResponse(response: JsonlRpcResponse): void {
    if (!response.id) {
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.pending.delete(response.id);
    if (!response.success) {
      pending.reject(
        new Error(
          response.error ?? `${this.diagnosticName} ${response.command ?? "request"} failed`,
        ),
      );
      return;
    }
    pending.resolve(response.data);
  }

  private handleStdinError(error: unknown): void {
    if (this.disposed) {
      return;
    }
    const err = error instanceof Error ? error : new Error(String(error));
    this.options.logger.warn({ err }, `${this.diagnosticName} stdin write failed`);
    void this.close(err);
  }

  private failAll(error: Error): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const pending of this.pending.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * Schedule a request timeout, or return null when the call should wait
 * indefinitely for a response, process exit, or close().
 */
function createRequestTimeout(
  timeoutMs: number | null,
  onTimeout: () => void,
): NodeJS.Timeout | null {
  if (timeoutMs == null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return null;
  }
  return setTimeout(onTimeout, timeoutMs);
}
