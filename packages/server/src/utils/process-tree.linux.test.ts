import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  captureProcessTree,
  killVerifiedProcessTree,
  parseLinuxProcStat,
  setProcessSourceForTesting,
  type ProcessTreeSnapshot,
} from "./process-tree.js";

/**
 * The daemon runs on Linux arm64 (Raspberry Pi 5), where process identity comes from /proc. These
 * lines were read on a Linux arm64 host (DGX OS on a GB10, kernel clock 100 Hz) on 2026-11-01:
 * PID 1, a shell whose comm was set to "my app) (x y", and a `cat` started in the same tick.
 */
const REAL_STAT_LINES = {
  init: "1 (systemd) S 0 1 1 0 -1 4194560 1623219 151732668 1416 431559 1556 1539 10623022 1196067 20 0 1 0 0 24182784 2515 18446744073709551615 1 1 0 0 0 0 671173123 4096 1260 0 0 0 17 8 0 0 0 0 0 0 0 0 0 0 0 0 0",
  oddComm:
    "48110 (my app) (x y) S 48108 48108 48108 0 -1 4194304 78 0 0 0 0 0 0 0 20 0 1 0 10508130 2449408 359 18446744073709551615 204026617593856 204026617713984 281474024705936 0 0 0 0 0 65538 1 0 0 17 5 0 0 0 0 0 204026617785760 204026617790960 204026758565888 281474024709624 281474024709690 281474024709690 281474024710124 0",
  cat: "48112 (cat) R 48108 48108 48108 0 -1 4194304 79 0 0 0 0 0 0 0 20 0 1 0 10508130 19525632 368 18446744073709551615 210490356793344 210490356818588 281474042405040 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0 210490356922976 210490356924616 210491385409536 281474042408484 281474042408504 281474042408504 281474042408939 0",
};

/** A stat line in the real layout with the fields this code reads replaced. */
function statLine(pid: number, ppid: number, pgid: number, startTicks: number, comm = "node") {
  return `${pid} (${comm}) S ${ppid} ${pgid} ${pgid} 0 -1 4194304 78 0 0 0 0 0 0 0 20 0 1 0 ${startTicks} 2449408 359 18446744073709551615 1 1 0 0 0 0 0 0 65538 1 0 0 17 5 0 0 0 0 0`;
}

let procRoot = "";
let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  procRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-fake-proc-"));
  setProcessSourceForTesting({ platform: "linux", procRoot });
  killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
});

afterEach(async () => {
  killSpy.mockRestore();
  setProcessSourceForTesting();
  await rm(procRoot, { recursive: true, force: true });
});

async function writeProc(lines: string[]) {
  await rm(procRoot, { recursive: true, force: true });
  await mkdir(procRoot, { recursive: true });
  // Non-process entries of a real /proc must be ignored.
  await mkdir(path.join(procRoot, "self"));
  await writeFile(path.join(procRoot, "uptime"), "1.0 1.0\n");
  for (const line of lines) {
    const pid = line.slice(0, line.indexOf(" "));
    await mkdir(path.join(procRoot, pid));
    await writeFile(path.join(procRoot, pid, "stat"), `${line}\n`);
  }
}

test("parses real Linux stat lines, including a command name with spaces and parentheses", () => {
  expect(parseLinuxProcStat(REAL_STAT_LINES.init)).toEqual({
    pid: 1,
    parentPid: 0,
    groupId: 1,
    started: "linux-ticks:0",
    zombie: false,
  });
  expect(parseLinuxProcStat(REAL_STAT_LINES.oddComm)).toEqual({
    pid: 48110,
    parentPid: 48108,
    groupId: 48108,
    started: "linux-ticks:10508130",
    zombie: false,
  });
  expect(parseLinuxProcStat(REAL_STAT_LINES.cat)).toMatchObject({ pid: 48112, groupId: 48108 });
  expect(parseLinuxProcStat(statLine(9, 1, 9, 5).replace(" S ", " Z "))).toMatchObject({
    zombie: true,
  });
  expect(() => parseLinuxProcStat("48110 my app S 1 1")).toThrow();
});

test("captures identities from /proc in clock ticks", async () => {
  await writeProc([REAL_STAT_LINES.init, REAL_STAT_LINES.oddComm, REAL_STAT_LINES.cat]);
  const snapshot = await captureProcessTree(48110, 48108);
  expect(snapshot.root.started).toBe("linux-ticks:10508130");
  // Same process group as the root, so its member belongs to the tree.
  expect([...snapshot.processes.keys()].toSorted()).toEqual([48110, 48112]);
});

function snapshotOf(pid: number, startTicks: number, groupId?: number): ProcessTreeSnapshot {
  const root = {
    pid,
    parentPid: 42,
    groupId: groupId ?? pid,
    started: `linux-ticks:${startTicks}`,
    zombie: false,
  };
  return { root, groupId, processes: new Map([[pid, root]]) };
}

test("a PID reused within the same second, but a later tick, is never signalled", async () => {
  // The replacement owns the same PID and group and started 30 ms after the original: one second
  // `lstart` would match, the tick count does not.
  await writeProc([statLine(7001, 42, 7001, 10508133)]);
  const snapshot = snapshotOf(7001, 10508130, 7001);
  const result = await killVerifiedProcessTree(snapshot, 1_000);
  expect(result.mismatched).toEqual([7001]);
  expect(result.killedGroup).toBeUndefined();
  expect(killSpy).not.toHaveBeenCalled();
  expect(snapshot.processes.has(7001)).toBe(false);
});

test("a process whose tick start still matches is killed, with its own group", async () => {
  await writeProc([statLine(7001, 42, 7001, 10508130), statLine(7002, 7001, 7001, 10508140)]);
  const snapshot = snapshotOf(7001, 10508130, 7001);
  snapshot.processes.set(7002, parseLinuxProcStat(statLine(7002, 7001, 7001, 10508140)));
  const result = await killVerifiedProcessTree(snapshot, 1_000);
  expect(result).toMatchObject({ killed: [7002, 7001], killedGroup: 7001, mismatched: [] });
  expect(killSpy.mock.calls).toEqual([
    [-7001, "SIGKILL"],
    [7002, "SIGKILL"],
    [7001, "SIGKILL"],
  ]);
});

test("PID 1, PID 0, this process and this process's group are never signalled", async () => {
  const ownGroup = 6000;
  await writeProc([
    REAL_STAT_LINES.init,
    statLine(process.pid, 1, ownGroup, 100),
    statLine(ownGroup, 1, ownGroup, 100),
  ]);
  for (const snapshot of [
    snapshotOf(1, 0, 1),
    snapshotOf(0, 0),
    snapshotOf(process.pid, 100, ownGroup),
    snapshotOf(ownGroup, 100, ownGroup),
  ]) {
    await killVerifiedProcessTree(snapshot, 1_000);
  }
  expect(killSpy.mock.calls.filter(([pid]) => pid === -ownGroup || pid === ownGroup)).toEqual([]);
  expect(killSpy.mock.calls.filter(([pid]) => (pid as number) <= 1 || pid === process.pid)).toEqual(
    [],
  );
});

test("a /proc that cannot be read signals nothing", async () => {
  setProcessSourceForTesting({ platform: "linux", procRoot: path.join(procRoot, "missing") });
  await expect(killVerifiedProcessTree(snapshotOf(7001, 10508130, 7001), 1_000)).rejects.toThrow();
  expect(killSpy).not.toHaveBeenCalled();
});
