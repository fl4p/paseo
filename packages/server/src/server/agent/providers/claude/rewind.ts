import {
  deleteSession as claudeDeleteSession,
  forkSession as claudeForkSession,
  type Query,
  type SessionStore,
  type SessionKey,
} from "@anthropic-ai/claude-agent-sdk";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { claudeProjectDirSync } from "./project-dir.js";

/**
 * Seam over the Claude Agent SDK's session mutation surface. Both rewind and
 * provider-native fork go through it so tests can drive them with
 * `FakeClaudeSdk` instead of a live CLI. `upToMessageId` is optional: rewind
 * always supplies one, a whole-session fork does not.
 */
export interface ClaudeRewindSdk {
  forkSession(
    sessionId: string,
    options?: { upToMessageId?: string },
  ): Promise<{ sessionId: string }>;
  /**
   * Remove a session file. Only ever used to roll a *just created* fork back
   * when the step after it fails, so the daemon does not leave an orphan
   * transcript on disk that would later surface as an importable session.
   */
  deleteSession(sessionId: string): Promise<void>;
}

export const realClaudeRewindSdk: ClaudeRewindSdk = {
  forkSession: claudeForkSession,
  deleteSession: (sessionId) => claudeDeleteSession(sessionId),
};

const StoreEntrySchema = z
  .object({ type: z.string(), uuid: z.string().optional(), timestamp: z.string().optional() })
  .passthrough();

/** SDK filesystem mutations otherwise resolve CLAUDE_CONFIG_DIR in the daemon. */
export function scopedClaudeRewindSdk(cwd: string, configDir: string): ClaudeRewindSdk {
  const projectDir = claudeProjectDirSync(cwd, { configDir });
  function entryPath(key: SessionKey): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(key.sessionId)) throw new Error("Invalid Claude session ID");
    if (key.subpath !== undefined) {
      if (
        !key.subpath ||
        path.isAbsolute(key.subpath) ||
        key.subpath.split(/[\\/]/).includes("..")
      ) {
        throw new Error("Invalid Claude session subpath");
      }
      return path.join(projectDir, key.sessionId, key.subpath);
    }
    return path.join(projectDir, `${key.sessionId}.jsonl`);
  }
  const store: SessionStore = {
    async load(key) {
      let content: string;
      try {
        content = await fs.readFile(entryPath(key), "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
      return content
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => StoreEntrySchema.parse(JSON.parse(line)));
    },
    async append(key, entries) {
      const target = entryPath(key);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.appendFile(target, entries.map((entry) => JSON.stringify(entry) + "\n").join(""), {
        mode: 0o600,
      });
    },
    async delete(key) {
      await fs.rm(entryPath(key), { force: true });
    },
  };
  return {
    forkSession: (sessionId, options) =>
      claudeForkSession(sessionId, { ...options, dir: cwd, sessionStore: store }),
    deleteSession: (sessionId) => claudeDeleteSession(sessionId, { dir: cwd, sessionStore: store }),
  };
}

export async function revertClaudeConversation(input: {
  sdk: ClaudeRewindSdk;
  sessionId: string | null;
  messageId: string;
  resolveMessageId?: (messageId: string) => string | Promise<string>;
  setSessionId: (sessionId: string) => void;
}): Promise<void> {
  if (!input.sessionId) {
    throw new Error("Claude session is not ready for rewind");
  }
  const messageId = (await input.resolveMessageId?.(input.messageId)) ?? input.messageId;
  const fork = await input.sdk.forkSession(input.sessionId, {
    upToMessageId: messageId,
  });
  input.setSessionId(fork.sessionId);
}

export async function revertClaudeFiles(input: {
  query: Query;
  messageId: string;
  resolveMessageId?: (messageId: string) => string | Promise<string>;
}): Promise<void> {
  const messageId = (await input.resolveMessageId?.(input.messageId)) ?? input.messageId;
  const result = await input.query.rewindFiles(messageId, { dryRun: false });
  if (!result.canRewind) {
    throw new Error(result.error ?? `No file checkpoint found for message ${messageId}`);
  }
}

export async function revertClaudeConversationAndFiles(input: {
  sdk: ClaudeRewindSdk;
  query: Query;
  sessionId: string | null;
  messageId: string;
  resolveMessageId?: (messageId: string) => string | Promise<string>;
  setSessionId: (sessionId: string) => void;
}): Promise<void> {
  await revertClaudeFiles({
    query: input.query,
    messageId: input.messageId,
    resolveMessageId: input.resolveMessageId,
  });
  await revertClaudeConversation(input);
}
