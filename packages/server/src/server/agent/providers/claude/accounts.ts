import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { AgentFeatureSelect } from "../../agent-sdk-types.js";
import { claudeProjectDirSync } from "./project-dir.js";

export const CLAUDE_ACCOUNT_FEATURE = "account";
export const DEFAULT_CLAUDE_ACCOUNT = "default";

const AccountSchema = z.object({
  label: z.string().trim().min(1),
  configDir: z.string().trim().min(1),
});
const ParamsSchema = z.object({
  accounts: z.record(z.string().min(1), AccountSchema).optional(),
});
export type ClaudeAccount = z.infer<typeof AccountSchema> & { id: string };

export class ClaudeAccountError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClaudeAccountError";
  }
}

export function parseClaudeAccounts(params: unknown): ClaudeAccount[] {
  const { accounts = {} } = ParamsSchema.parse(params ?? {});
  return Object.entries(accounts).map(([id, account]) => {
    if (id === DEFAULT_CLAUDE_ACCOUNT) {
      throw new ClaudeAccountError("The Claude account ID 'default' is reserved.");
    }
    const configDir = account.configDir.startsWith("~/")
      ? path.join(homedir(), account.configDir.slice(2))
      : account.configDir;
    if (!path.isAbsolute(configDir)) {
      throw new ClaudeAccountError(
        `Claude account '${id}' needs an absolute configDir or ~/ path.`,
      );
    }
    return { id, label: account.label, configDir: path.normalize(configDir) };
  });
}

export function resolveClaudeAccount(
  accounts: ClaudeAccount[],
  value: unknown,
): ClaudeAccount | null {
  if (value === undefined || value === DEFAULT_CLAUDE_ACCOUNT) return null;
  const account = accounts.find((entry) => entry.id === value);
  if (!account) throw new ClaudeAccountError(`Unknown Claude account: ${String(value)}`);
  return account;
}

export function claudeAccountFeature(
  accounts: ClaudeAccount[],
  value: unknown,
): AgentFeatureSelect[] {
  const account = resolveClaudeAccount(accounts, value);
  if (accounts.length === 0) return [];
  return [
    {
      type: "select",
      id: CLAUDE_ACCOUNT_FEATURE,
      label: "Account",
      tooltip: "Choose a Claude subscription account (running subagents resume after switching)",
      value: account?.id ?? DEFAULT_CLAUDE_ACCOUNT,
      options: [
        { id: DEFAULT_CLAUDE_ACCOUNT, label: "Default account" },
        ...accounts.map(({ id, label }) => ({ id, label })),
      ],
    },
  ];
}

// Named subscription accounts must not inherit a daemon's API key or OAuth token.
// The CLI owns credential lookup and refresh in the selected directory.
export function claudeAccountEnv(account: ClaudeAccount | null): NodeJS.ProcessEnv {
  if (!account) return {};
  return {
    CLAUDE_CONFIG_DIR: account.configDir,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_SCOPES: undefined,
    CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: undefined,
    CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: undefined,
    ANTHROPIC_CUSTOM_HEADERS: undefined,
    ANTHROPIC_BASE_URL: undefined,
    CLAUDE_CODE_USE_BEDROCK: undefined,
    CLAUDE_CODE_USE_MANTLE: undefined,
    CLAUDE_CODE_USE_ANTHROPIC_AWS: undefined,
    CLAUDE_CODE_USE_VERTEX: undefined,
    CLAUDE_CODE_USE_FOUNDRY: undefined,
  };
}

const TranscriptEntrySchema = z.object({ type: z.string() }).passthrough();
const ConversationMessageSchema = z.object({
  content: z.union([z.string(), z.array(z.unknown())]),
});

/** Keep message UUIDs and compaction links; only the native session identity changes. */
function reidentifyTranscript(content: string, sessionId: string): string {
  let hasConversation = false;
  const lines = content.split("\n").map((line) => {
    if (!line.trim()) return line;
    const entry = TranscriptEntrySchema.parse(JSON.parse(line));
    if (entry.type === "user" || entry.type === "assistant") {
      const message = ConversationMessageSchema.parse(entry.message);
      hasConversation ||= message.content.length > 0;
    }
    if ("sessionId" in entry) entry.sessionId = sessionId;
    return JSON.stringify(entry);
  });
  if (!hasConversation)
    throw new ClaudeAccountError("Cannot switch accounts: the conversation transcript is empty.");
  return lines.join("\n");
}

interface CopyClaudeConversationInput {
  sourcePath: string;
  sourceConfigDir: string;
  targetConfigDir: string;
  cwd: string;
}

/** Copy only this conversation, never credentials or another account's settings. */
export async function copyClaudeConversation(input: CopyClaudeConversationInput): Promise<string> {
  const sessionId = randomUUID();
  const sourceId = path.basename(input.sourcePath, ".jsonl");
  const targetProject = claudeProjectDirSync(input.cwd, { configDir: input.targetConfigDir });
  const targetPath = path.join(targetProject, `${sessionId}.jsonl`);
  const targetArtifacts = path.join(targetProject, sessionId);
  const targetHistory = path.join(input.targetConfigDir, "file-history", sessionId);
  // Read and validate before creating anything. Missing, empty, or malformed history
  // must not turn an account switch into an empty conversation.
  const transcript = reidentifyTranscript(await fs.readFile(input.sourcePath, "utf8"), sessionId);
  await fs.mkdir(targetProject, { recursive: true, mode: 0o700 });
  const ownedPaths: string[] = [];
  try {
    await fs.mkdir(targetArtifacts, { mode: 0o700 });
    ownedPaths.push(targetArtifacts);
    await fs.mkdir(path.dirname(targetHistory), { recursive: true, mode: 0o700 });
    await fs.mkdir(targetHistory, { mode: 0o700 });
    ownedPaths.push(targetHistory);
    await copyOptionalDirectory(
      path.join(path.dirname(input.sourcePath), sourceId),
      targetArtifacts,
    );
    await copyOptionalDirectory(
      path.join(input.sourceConfigDir, "file-history", sourceId),
      targetHistory,
    );
    const file = await fs.open(targetPath, "wx", 0o600);
    ownedPaths.push(targetPath);
    try {
      await file.writeFile(transcript);
    } finally {
      await file.close();
    }
    return sessionId;
  } catch (error) {
    for (const owned of ownedPaths) await fs.rm(owned, { recursive: true, force: true });
    throw error;
  }
}

async function copyOptionalDirectory(source: string, target: string): Promise<void> {
  try {
    await fs.stat(source);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of await fs.readdir(source)) {
    await fs.cp(path.join(source, entry), path.join(target, entry), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
}

/** Validate sidecars before stopping work, then again after the writer has exited. */
export async function validateClaudeAccountSubagents(
  sourcePath: string | null,
  taskIds: readonly string[],
): Promise<void> {
  if (taskIds.length === 0) return;
  if (!sourcePath)
    throw new ClaudeAccountError("Cannot migrate subagents without a saved conversation.");
  const sourceId = path.basename(sourcePath, ".jsonl");
  for (const taskId of taskIds) {
    if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) {
      throw new ClaudeAccountError("Cannot migrate a subagent with an invalid native ID.");
    }
    const transcriptPath = path.join(
      path.dirname(sourcePath),
      sourceId,
      "subagents",
      `agent-${taskId}.jsonl`,
    );
    try {
      reidentifyTranscript(await fs.readFile(transcriptPath, "utf8"), sourceId);
      const metadata = z
        .object({
          agentType: z.string().min(1),
          toolUseId: z.string().min(1),
          stoppedByUser: z.boolean().optional(),
        })
        .parse(
          JSON.parse(await fs.readFile(transcriptPath.replace(/\.jsonl$/, ".meta.json"), "utf8")),
        );
      if (metadata.stoppedByUser)
        throw new Error("This subagent was explicitly stopped by the user.");
    } catch (error) {
      throw new ClaudeAccountError(
        `Cannot migrate subagent ${taskId}: its saved transcript is missing or incomplete. Wait for it to save or finish before switching.`,
        { cause: error },
      );
    }
  }
}

export function claudeAccountRecoveryPrompt(
  taskIds: readonly string[],
  interruptedTaskIds: readonly string[] = [],
): string {
  return [
    "Paseo stopped the previous Claude process while changing accounts. Continue under the currently selected account.",
    "You alone coordinate recovery: send exactly one SendMessage (to: ID) to each saved subagent in this list, including nested agents:",
    JSON.stringify(taskIds),
    "Send each one this instruction: Continue your original task from your saved context. Your previous process was stopped for an account switch. First inspect the outcome of any interrupted tool or shell command; do not blindly repeat it or duplicate side effects. The coordinator is recovering every listed descendant separately. Do not resume or message descendants as part of recovery, and do not launch replacements.",
    `Background tasks created during shutdown and interrupted with the old process: ${JSON.stringify(interruptedTaskIds)}. Report these interruptions to the user and inspect their results; do not restart those commands or workflows automatically.`,
    "Do not launch replacement agents or repeat their original prompts. If a saved agent cannot be resumed, report its ID and the error to the user. Do not claim recovery succeeded until Claude confirms the agent resumed.",
  ].join("\n");
}
