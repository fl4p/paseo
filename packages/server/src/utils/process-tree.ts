import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TerminateWithTreeKillOptions, TerminateWithTreeKillResult } from "./tree-kill.js";

const execFileAsync = promisify(execFile);

interface ProcessIdentity {
  pid: number;
  parentPid: number;
  groupId?: number;
  started: string;
  zombie: boolean;
}

/** Retained ownership survives the root exiting and descendants being reparented. */
export interface ProcessTreeSnapshot {
  readonly processes: Map<number, ProcessIdentity>;
  readonly groupId?: number;
  readonly root: ProcessIdentity;
}

async function readProcesses(): Promise<ProcessIdentity[]> {
  const options = { timeout: 5_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" as const };
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{Name='Started';Expression={if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().Ticks.ToString()} else {''}}} | ConvertTo-Json -Compress",
      ],
      options,
    );
    const parsed: unknown = JSON.parse(stdout);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row: Record<string, unknown>) => {
      if (
        typeof row.ProcessId !== "number" ||
        typeof row.ParentProcessId !== "number" ||
        typeof row.Started !== "string"
      )
        throw new Error("Cannot verify Windows process identities");
      return {
        pid: row.ProcessId,
        parentPid: row.ParentProcessId,
        started: row.Started,
        zombie: false,
      };
    });
  }
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,stat="], {
    ...options,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout
    .trim()
    .split("\n")
    .map((line) => {
      const fields = line.trim().split(/\s+/);
      if (fields.length !== 9) throw new Error("Cannot verify POSIX process identities");
      const pid = Number(fields[0]),
        parentPid = Number(fields[1]);
      if (!Number.isInteger(pid) || !Number.isInteger(parentPid))
        throw new Error("Invalid process identity");
      return {
        pid,
        parentPid,
        groupId: Number(fields[2]),
        started: fields.slice(3, 8).join(" "),
        zombie: fields[8]!.startsWith("Z"),
      };
    });
}

function collectDescendants(
  snapshot: ProcessTreeSnapshot,
  rows: ProcessIdentity[],
): ProcessIdentity[] {
  const alive = new Map<number, ProcessIdentity>();
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  for (const [pid, identity] of snapshot.processes) {
    const row = byPid.get(pid);
    if (row?.started === identity.started && !row.zombie) alive.set(pid, row);
  }
  const leader = snapshot.groupId === undefined ? undefined : byPid.get(snapshot.groupId);
  const originalGroup = !leader || leader.started === snapshot.root.started;
  if (snapshot.groupId !== undefined && originalGroup) {
    for (const row of rows) {
      if (row.groupId !== snapshot.groupId || row.zombie) continue;
      snapshot.processes.set(row.pid, row);
      alive.set(row.pid, row);
    }
  }
  // Preserve parent-before-child ordering, so signals are sent to children first.
  const frontier = [...alive.keys()];
  for (const parentPid of frontier) {
    for (const row of rows) {
      if (row.parentPid !== parentPid || row.zombie || alive.has(row.pid)) continue;
      if (!row.started) throw new Error("Cannot verify a descendant process identity");
      alive.set(row.pid, row);
      snapshot.processes.set(row.pid, row);
      frontier.push(row.pid);
    }
  }
  return [...alive.values()];
}

export async function captureProcessTree(
  pid: number,
  groupId?: number,
): Promise<ProcessTreeSnapshot> {
  const rows = await readProcesses();
  const root = rows.find((row) => row.pid === pid && !row.zombie);
  if (!root || !root.started)
    throw new Error(
      "Claude exited before its descendant processes could be identified. Cannot verify account-switch cleanup.",
    );
  const snapshot: ProcessTreeSnapshot = { processes: new Map([[pid, root]]), groupId, root };
  collectDescendants(snapshot, rows);
  return snapshot;
}

/** Refresh ownership while the original root is still live, without rebinding its identity. */
export async function refreshProcessTree(snapshot: ProcessTreeSnapshot): Promise<void> {
  collectDescendants(snapshot, await readProcesses());
}

function signalProcesses(rows: ProcessIdentity[], signal: NodeJS.Signals): void {
  for (const row of rows.toReversed()) {
    try {
      process.kill(row.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

async function stopPhase(
  snapshot: ProcessTreeSnapshot,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const alive = collectDescendants(snapshot, await readProcesses());
    if (alive.length === 0) return true;
    signalProcesses(alive, signal);
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Never equate root exit with all previously owned processes having stopped. */
export async function terminateCapturedProcessTree(
  snapshot: ProcessTreeSnapshot,
  options: TerminateWithTreeKillOptions,
): Promise<TerminateWithTreeKillResult> {
  if (await stopPhase(snapshot, options.gracefulSignal ?? "SIGTERM", options.gracefulTimeoutMs))
    return "terminated";
  options.onForceSignal?.();
  const killed = await stopPhase(
    snapshot,
    options.forceSignal ?? "SIGKILL",
    options.forceTimeoutMs ?? 2_000,
  );
  return killed ? "killed" : "kill-timeout";
}
