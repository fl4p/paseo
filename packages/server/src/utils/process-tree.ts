import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
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

/**
 * Where process identities come from. Linux reads /proc: the start time there is in clock ticks
 * since boot (10 ms at the usual 100 Hz), so a PID reused even within the same second does not
 * pass as its predecessor. Elsewhere `ps` is used, and on macOS its `lstart` has one-second
 * resolution: a PID reused within the same second as its predecessor started is indistinguishable
 * there. macOS exposes no finer start time to a CLI (the kernel's microsecond p_starttime is only
 * reachable through sysctl from native code), so that remains a documented limit.
 */
interface ProcessSource {
  platform: NodeJS.Platform;
  procRoot: string;
}

const defaultProcessSource: ProcessSource = { platform: process.platform, procRoot: "/proc" };
let processSource = defaultProcessSource;

/** Tests only: read identities from a fixture /proc tree as if on `platform`. */
export function setProcessSourceForTesting(source?: Partial<ProcessSource>): void {
  processSource = source ? { ...defaultProcessSource, ...source } : defaultProcessSource;
}

/**
 * One /proc/<pid>/stat line. The command name (field 2) is in parentheses and may itself contain
 * spaces and parentheses, so the fixed fields are read after the last ')': state (3), ppid (4),
 * process group (5) and start time in clock ticks (22).
 */
export function parseLinuxProcStat(line: string): ProcessIdentity {
  const open = line.indexOf("(");
  const close = line.lastIndexOf(")");
  if (open < 0 || close < open) throw new Error("Cannot parse a /proc stat line");
  const pid = Number(line.slice(0, open).trim());
  const fields = line
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  if (fields.length < 20) throw new Error("Cannot parse a /proc stat line");
  const state = fields[0]!;
  const parentPid = Number(fields[1]);
  const groupId = Number(fields[2]);
  const startTicks = fields[19]!;
  if (
    !Number.isInteger(pid) ||
    !Number.isInteger(parentPid) ||
    !Number.isInteger(groupId) ||
    !/^\d+$/.test(startTicks)
  ) {
    throw new Error("Invalid /proc process identity");
  }
  return {
    pid,
    parentPid,
    groupId,
    started: `linux-ticks:${startTicks}`,
    zombie: state === "Z" || state === "X",
  };
}

async function readLinuxProcesses(procRoot: string): Promise<ProcessIdentity[]> {
  const names = (await readdir(procRoot)).filter((name) => /^\d+$/.test(name));
  const rows = await Promise.all(
    names.map(async (name) => {
      let line: string;
      try {
        line = await readFile(path.join(procRoot, name, "stat"), "utf8");
      } catch {
        return null; // Exited while being listed.
      }
      return parseLinuxProcStat(line);
    }),
  );
  return rows.filter((row): row is ProcessIdentity => row !== null);
}

async function readProcesses(timeoutMs = 5_000): Promise<ProcessIdentity[]> {
  const source = processSource;
  if (source.platform === "linux") {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        readLinuxProcesses(source.procRoot),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Reading /proc timed out")),
            Math.max(1, timeoutMs),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const options = { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" as const };
  if (source.platform === "win32") {
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

/** Never signalled whatever a snapshot says: init, the kernel's PIDs, and this process. */
function isProtectedPid(pid: number): boolean {
  return !Number.isInteger(pid) || pid <= 1 || pid === process.pid;
}

function signalProcesses(rows: ProcessIdentity[], signal: NodeJS.Signals): void {
  for (const row of rows.toReversed()) {
    if (isProtectedPid(row.pid)) continue;
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

export interface VerifiedKillResult {
  /** PIDs that still matched the snapshot and were sent SIGKILL. */
  killed: number[];
  /** The snapshot's own process group, sent SIGKILL because its leader is still the root. */
  killedGroup?: number;
  /** PIDs now held by a different process (start time or group changed); never signalled. */
  mismatched: number[];
  /**
   * PIDs never signalled whatever their identity: PID 1 and below, this process, and the leader of
   * its process group.
   */
  protected: number[];
}

/**
 * Last-resort SIGKILL for a snapshot whose orderly termination could not finish. A PID in a stale
 * snapshot may since belong to an unrelated process, so one quick enumeration decides: only a PID
 * whose start time (and process group, where both are known) still match is signalled. Exited and
 * reused PIDs are dropped from the snapshot. Throws if the enumeration fails; the caller then
 * signals nothing beyond what it can verify by other means.
 *
 * Identity is only as fine as the platform's start time (see ProcessSource: clock ticks on Linux,
 * one second on macOS). Checking and signalling are not atomic either: a process that exits and
 * whose PID is reused between the probe and the signal would be hit. Both windows are tiny, and
 * PID 1 and below, this process and its own process group are never signalled at all.
 */
export async function killVerifiedProcessTree(
  snapshot: ProcessTreeSnapshot,
  timeoutMs: number,
): Promise<VerifiedKillResult> {
  const rows = await readProcesses(Math.max(1, timeoutMs));
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const result: VerifiedKillResult = { killed: [], mismatched: [], protected: [] };
  const ownGroup = byPid.get(process.pid)?.groupId;
  if (ownsItsGroup(snapshot, byPid, ownGroup) && sendKill(-snapshot.groupId!)) {
    result.killedGroup = snapshot.groupId;
  }
  for (const [pid, identity] of Array.from(snapshot.processes).toReversed()) {
    // Also the leader of this process's own group (the shell or service that started it).
    if (isProtectedPid(pid) || pid === ownGroup) {
      result.protected.push(pid);
      continue;
    }
    const row = byPid.get(pid);
    if (!row || row.zombie) {
      snapshot.processes.delete(pid);
    } else if (!sameIdentity(identity, row)) {
      snapshot.processes.delete(pid);
      result.mismatched.push(pid);
    } else if (sendKill(pid)) {
      result.killed.push(pid);
    } else {
      snapshot.processes.delete(pid);
    }
  }
  return result;
}

/** The snapshot's own process group, still led by its root, and not this process's group. */
function ownsItsGroup(
  snapshot: ProcessTreeSnapshot,
  byPid: Map<number, ProcessIdentity>,
  ownGroup: number | undefined,
): boolean {
  const groupId = snapshot.groupId;
  if (groupId === undefined || isProtectedPid(groupId) || groupId === ownGroup) return false;
  if (processSource.platform === "win32") return false;
  const leader = byPid.get(groupId);
  return leader !== undefined && !leader.zombie && leader.started === snapshot.root.started;
}

function sameIdentity(remembered: ProcessIdentity, current: ProcessIdentity): boolean {
  const sameGroup =
    remembered.groupId === undefined ||
    current.groupId === undefined ||
    remembered.groupId === current.groupId;
  return Boolean(remembered.started) && current.started === remembered.started && sameGroup;
}

/** SIGKILL; false if the target is already gone. */
function sendKill(target: number): boolean {
  try {
    process.kill(target, "SIGKILL");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return false;
  }
}
