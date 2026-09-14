import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { buildProviderRegistry } from "../../provider-registry.js";
import type { ClaudeOptions } from "./query.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

test("offers the configured subscription accounts when creating a session", async () => {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    providerParams: { accounts: { work: { label: "Work", configDir: "/tmp/claude-work" } } },
  });
  expect(await client.listFeatures({ provider: "claude", cwd: process.cwd() })).toContainEqual(
    expect.objectContaining({
      type: "select",
      id: "account",
      value: "default",
      options: [
        { id: "default", label: "Default account" },
        { id: "work", label: "Work" },
      ],
    }),
  );
});

test("switches a resumed conversation into an isolated account and persists that choice", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-accounts-"));
  roots.push(root);
  const source = path.join(root, "source");
  const target = path.join(root, "work");
  vi.stubEnv("CLAUDE_CONFIG_DIR", source);
  const sourceId = "00000000-0000-4000-8000-000000000301";
  const project = claudeProjectDirSync(root, { configDir: source });
  await fs.mkdir(project, { recursive: true });
  const entry = {
    type: "user",
    uuid: "00000000-0000-4000-8000-000000000302",
    sessionId: sourceId,
    message: { role: "user", content: "Remember this conversation" },
  };
  const original = JSON.stringify(entry) + "\n";
  await fs.writeFile(path.join(project, `${sourceId}.jsonl`), original);
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    providerParams: { accounts: { work: { label: "Work", configDir: target } } },
  });
  const session = await client.resumeSession({
    provider: "claude",
    sessionId: sourceId,
    metadata: { cwd: root },
  });
  try {
    const switching = session.setFeature?.("account", "work");
    await expect(session.setFeature?.("account", "work")).rejects.toThrow("already in progress");
    await expect(session.startTurn("race")).rejects.toThrow("Account switch in progress");
    await switching;
    const handle = session.describePersistence();
    expect(handle?.sessionId).not.toBe(sourceId);
    expect(handle?.metadata).toMatchObject({ featureValues: { account: "work" } });
    const targetProject = claudeProjectDirSync(root, { configDir: target });
    const copied = await fs.readFile(
      path.join(targetProject, `${handle?.sessionId}.jsonl`),
      "utf8",
    );
    expect(JSON.parse(copied)).toEqual({ ...entry, sessionId: handle?.sessionId });
    expect(await fs.readFile(path.join(project, `${sourceId}.jsonl`), "utf8")).toBe(original);
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(source);
    expect(session.features).toContainEqual(
      expect.objectContaining({ id: "account", value: "work" }),
    );
    const fork = await session.forkProviderSession?.({});
    const forkPath = path.join(targetProject, `${fork?.providerHandleId}.jsonl`);
    expect(await fs.readFile(forkPath, "utf8")).toContain("Remember this conversation");
    await session.setFeature?.("account", "default");
    expect(session.describePersistence()?.metadata).toMatchObject({
      featureValues: { account: "default" },
    });
  } finally {
    await session.close();
  }
});

test("does not fall back to another account when the selected account was removed", async () => {
  const client = new ClaudeAgentClient({ logger: createTestLogger() });
  await expect(
    client.createSession({
      provider: "claude",
      cwd: process.cwd(),
      featureValues: { account: "deleted" },
    }),
  ).rejects.toThrow("Unknown Claude account: deleted");
});

test.each([undefined, "", "not json", '{"type":"user"}\n{"partial":'])(
  "keeps the previous account and handle when the transcript cannot be copied: %s",
  async (transcript) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-accounts-invalid-"));
    roots.push(root);
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    vi.stubEnv("CLAUDE_CONFIG_DIR", source);
    const project = claudeProjectDirSync(root, { configDir: source });
    await fs.mkdir(project, { recursive: true });
    if (transcript !== undefined)
      await fs.writeFile(path.join(project, "original.jsonl"), transcript);
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      providerParams: { accounts: { work: { label: "Work", configDir: target } } },
    });
    const session = await client.resumeSession({
      provider: "claude",
      sessionId: "original",
      metadata: { cwd: root },
    });
    try {
      await expect(session.setFeature?.("account", "work")).rejects.toThrow();
      expect(session.id).toBe("original");
      expect(session.features).toContainEqual(
        expect.objectContaining({ id: "account", value: "default" }),
      );
      await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await session.close();
    }
  },
);

test("isolates concurrent launch environments and keeps the chosen account after resume", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "inherited-test-key");
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "inherited-test-token");
  vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "Authorization: Bearer inherited-test-token");
  vi.stubEnv("CLAUDE_CODE_USE_MANTLE", "1");
  vi.stubEnv("CLAUDE_CODE_USE_ANTHROPIC_AWS", "1");
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "99");
  vi.stubEnv("CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "98");
  vi.stubEnv("CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "inherited-test-refresh-token");
  vi.stubEnv("CLAUDE_CODE_OAUTH_SCOPES", "user:inference");
  const captured: ClaudeOptions[] = [];
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => "/test/claude",
    runtimeSettings: {
      env: {
        ANTHROPIC_AUTH_TOKEN: "provider-test-token",
        CLAUDE_CONFIG_DIR: "/tmp/default-claude",
      },
    },
    providerParams: {
      accounts: {
        work: { label: "Work", configDir: "/tmp/work-claude" },
        personal: { label: "Personal", configDir: "/tmp/personal-claude" },
      },
    },
    queryFactory: ({ options }) => {
      captured.push(options);
      throw new Error("launch captured");
    },
  });
  const work = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
    featureValues: { account: "work" },
  });
  const personal = await client.resumeSession({
    provider: "claude",
    sessionId: "personal-session",
    metadata: { cwd: process.cwd(), featureValues: { account: "personal" } },
  });
  try {
    await Promise.all(
      [work, personal].map(async (session) => {
        await expect(session.listCommands?.()).rejects.toThrow("launch captured");
      }),
    );
    expect(captured.map((options) => options.env?.CLAUDE_CONFIG_DIR).sort()).toEqual([
      "/tmp/personal-claude",
      "/tmp/work-claude",
    ]);
    for (const options of captured) {
      expect(options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(options.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
      expect(options.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
      expect(options.env).not.toHaveProperty("ANTHROPIC_CUSTOM_HEADERS");
      expect(options.env).not.toHaveProperty("CLAUDE_CODE_USE_MANTLE");
      expect(options.env).not.toHaveProperty("CLAUDE_CODE_USE_ANTHROPIC_AWS");
      expect(options.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR");
      expect(options.env).not.toHaveProperty("CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR");
      expect(options.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_REFRESH_TOKEN");
      expect(options.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_SCOPES");
    }
    expect(
      captured.find((options) => options.resume === "personal-session")?.env?.CLAUDE_CONFIG_DIR,
    ).toBe("/tmp/personal-claude");
    expect(process.env.ANTHROPIC_API_KEY).toBe("inherited-test-key");
  } finally {
    await work.close();
    await personal.close();
  }
});

test("the provider registry passes account configuration to Claude", async () => {
  const logger = createTestLogger();
  const registry = buildProviderRegistry(logger, {
    providerOverrides: {
      claude: { params: { accounts: { work: { label: "Work", configDir: "/tmp/work-claude" } } } },
    },
  });
  const client = registry.claude.createClient(logger);
  expect(await client.listFeatures?.({ provider: "claude", cwd: process.cwd() })).toContainEqual(
    expect.objectContaining({
      id: "account",
      options: [
        { id: "default", label: "Default account" },
        { id: "work", label: "Work" },
      ],
    }),
  );
});

test("refuses an account switch while a turn is starting", async () => {
  let finishResolve: (path: string) => void = () => {
    throw new Error("Resolver not started");
  };
  const resolving = new Promise<string>((resolve) => {
    finishResolve = resolve;
  });
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: () => resolving,
    providerParams: { accounts: { work: { label: "Work", configDir: "/tmp/work-claude" } } },
    queryFactory: () => {
      throw new Error("test launch stopped");
    },
  });
  const session = await client.createSession({ provider: "claude", cwd: process.cwd() });
  const starting = session.startTurn("hello");
  try {
    await expect(session.setFeature?.("account", "work")).rejects.toThrow("Stop the current turn");
    expect(session.features).toContainEqual(
      expect.objectContaining({ id: "account", value: "default" }),
    );
  } finally {
    finishResolve("/test/claude");
    await starting;
    await session.close();
  }
});
