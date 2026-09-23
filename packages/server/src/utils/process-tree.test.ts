import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { captureProcessTree, terminateCapturedProcessTree } from "./process-tree.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
const pids: number[] = [];
afterEach(async () => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const child of children.splice(0)) child.kill("SIGKILL");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(detachedParent = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-captured-tree-"));
  roots.push(root);
  const pidFile = path.join(root, "child.pid");
  const script = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(`process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`)}],{stdio:'ignore',detached:true});process.stdout.write(String(child.pid));child.unref();setInterval(()=>{},1000);`;
  const parent = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "ignore"],
    detached: detachedParent,
  });
  children.push(parent);
  const [reportedPid] = await once(parent.stdout!, "data");
  const pid = Number(String(reportedPid));
  pids.push(pid);
  await vi.waitFor(
    async () => {
      expect(Number(await readFile(pidFile, "utf8"))).toBe(pid);
    },
    { timeout: 5_000 },
  );
  return { parent, pid };
}

test("retains descendants after SDK root shutdown and escalates an ignored SIGTERM", async () => {
  const { parent, pid } = await fixture();
  const snapshot = await captureProcessTree(parent.pid!);
  expect(snapshot.processes.has(pid)).toBe(true);
  const exited = once(parent, "exit");
  parent.kill("SIGKILL");
  await exited;
  expect(() => process.kill(pid, 0)).not.toThrow();
  const result = await terminateCapturedProcessTree(snapshot, {
    gracefulTimeoutMs: 100,
    forceTimeoutMs: 2000,
  });
  expect(result).toBe(process.platform === "win32" ? "terminated" : "killed");
  expect(
    await terminateCapturedProcessTree(snapshot, { gracefulTimeoutMs: 100, forceTimeoutMs: 100 }),
  ).toBe("terminated");
});

test("does not stop escalating just because the parent exits on SIGTERM", async () => {
  const { parent, pid } = await fixture();
  const snapshot = await captureProcessTree(parent.pid!);
  const result = await terminateCapturedProcessTree(snapshot, {
    gracefulTimeoutMs: 100,
    forceTimeoutMs: 2000,
  });
  expect(result).toBe(process.platform === "win32" ? "terminated" : "killed");
  expect(parent.exitCode !== null || parent.signalCode !== null).toBe(true);
  // Removing an identity prevents ownership by a reused numeric PID.
  snapshot.processes.set(pid, { pid, parentPid: 0, started: "a different process", zombie: false });
  expect(
    await terminateCapturedProcessTree(snapshot, { gracefulTimeoutMs: 100, forceTimeoutMs: 100 }),
  ).toBe("terminated");
});

test.runIf(process.platform !== "win32")(
  "finds a late inherited child after the group leader exits",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-late-group-"));
    roots.push(root);
    const pidFile = path.join(root, "late.pid");
    const childCode = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
    const ownerCode = `process.on('SIGTERM',()=>{const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});c.unref();setTimeout(()=>process.exit(0),100);});process.stdout.write('ready');setInterval(()=>{},1000);`;
    const parent = spawn(process.execPath, ["-e", ownerCode], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    children.push(parent);
    await once(parent.stdout!, "data");
    const snapshot = await captureProcessTree(parent.pid!, parent.pid!);
    const exited = once(parent, "exit");
    parent.kill("SIGTERM");
    await exited;
    let pid = 0;
    await vi.waitFor(
      async () => {
        pid = Number(await readFile(pidFile, "utf8"));
        expect(pid).toBeGreaterThan(0);
      },
      { timeout: 5_000 },
    );
    pids.push(pid);
    expect(snapshot.processes.has(pid)).toBe(false);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(
      await terminateCapturedProcessTree(snapshot, {
        gracefulTimeoutMs: 100,
        forceTimeoutMs: 2000,
      }),
    ).toBe("killed");
    expect(snapshot.processes.has(pid)).toBe(true);
  },
);

test.runIf(process.platform !== "win32")(
  "does not adopt a reused group leader with a different birth identity",
  async () => {
    const { parent, pid } = await fixture(true);
    const current = await captureProcessTree(parent.pid!, parent.pid!);
    const previousRoot = { ...current.root, started: "previous owner's birth identity" };
    const stale = {
      ...current,
      root: previousRoot,
      processes: new Map([[parent.pid!, previousRoot]]),
    };
    expect(
      await terminateCapturedProcessTree(stale, { gracefulTimeoutMs: 100, forceTimeoutMs: 100 }),
    ).toBe("terminated");
    expect(() => process.kill(parent.pid!, 0)).not.toThrow();
    expect(() => process.kill(pid, 0)).not.toThrow();
  },
);
