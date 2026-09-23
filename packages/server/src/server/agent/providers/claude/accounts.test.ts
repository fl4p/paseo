import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { copyClaudeConversation, parseClaudeAccounts } from "./accounts.js";
import { claudeProjectDirSync } from "./project-dir.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

test("copies compaction links, subagent files and file checkpoints without credentials", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-account-copy-"));
  roots.push(root);
  const sourceConfigDir = path.join(root, "source");
  const targetConfigDir = path.join(root, "target");
  const project = claudeProjectDirSync(root, { configDir: sourceConfigDir });
  const sourcePath = path.join(project, "source-session.jsonl");
  const entries = [
    {
      type: "user",
      uuid: "first",
      sessionId: "source-session",
      message: { role: "user", content: "hello" },
    },
    {
      type: "system",
      subtype: "compact_boundary",
      uuid: "boundary",
      parentUuid: "first",
      sessionId: "source-session",
      compactMetadata: { preservedSegment: { headUuid: "first", tailUuid: "first" } },
    },
  ];
  await fs.mkdir(path.join(project, "source-session", "subagents"), { recursive: true });
  await fs.mkdir(path.join(sourceConfigDir, "file-history", "source-session"), { recursive: true });
  await fs.writeFile(sourcePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await fs.writeFile(
    path.join(project, "source-session", "subagents", "agent-child.jsonl"),
    "subagent history",
  );
  await fs.writeFile(
    path.join(sourceConfigDir, "file-history", "source-session", "checkpoint"),
    "original file",
  );
  await fs.writeFile(
    path.join(sourceConfigDir, ".credentials.json"),
    "secret fixture, never copied",
  );
  const sessionId = await copyClaudeConversation({
    sourcePath,
    sourceConfigDir,
    targetConfigDir,
    cwd: root,
  });
  const targetProject = claudeProjectDirSync(root, { configDir: targetConfigDir });
  const copied = await fs.readFile(path.join(targetProject, `${sessionId}.jsonl`), "utf8");
  expect(
    copied
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toEqual(entries.map((entry) => Object.assign({}, entry, { sessionId })));
  expect(
    await fs.readFile(
      path.join(targetProject, sessionId, "subagents", "agent-child.jsonl"),
      "utf8",
    ),
  ).toBe("subagent history");
  expect(
    await fs.readFile(path.join(targetConfigDir, "file-history", sessionId, "checkpoint"), "utf8"),
  ).toBe("original file");
  await expect(fs.stat(path.join(targetConfigDir, ".credentials.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test.each([undefined, "", "relative/path", "../other"])(
  "rejects unusable account paths: %s",
  (configDir) => {
    expect(() =>
      parseClaudeAccounts({ accounts: { work: { label: "Work", configDir } } }),
    ).toThrow();
  },
);

test("expands home paths and rejects the reserved default account", () => {
  expect(
    parseClaudeAccounts({ accounts: { work: { label: "Work", configDir: "~/.claude-work" } } }),
  ).toEqual([{ id: "work", label: "Work", configDir: path.join(os.homedir(), ".claude-work") }]);
  expect(() =>
    parseClaudeAccounts({ accounts: { default: { label: "Other", configDir: "/tmp/other" } } }),
  ).toThrow("reserved");
});
