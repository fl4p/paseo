import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  deleteSession as claudeDeleteSession,
  forkSession as claudeForkSession,
  type Query,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { claudeProjectDirSync } from "./project-dir.js";

/**
 * Seam over the Claude Agent SDK's session mutation surface. Both rewind and
 * provider-native fork go through it so tests can drive them with
 * `FakeClaudeSdk` instead of a live CLI. `upToMessageId` is optional: rewind
 * always supplies one, a whole-session fork does not. `transcriptPath`, when known,
 * names the transcript's real location, which can differ from the folder `cwd` encodes to.
 */
export interface ClaudeRewindSdk {
  forkSession(
    sessionId: string,
    options?: { upToMessageId?: string; transcriptPath?: string },
  ): Promise<{ sessionId: string }>;
  /**
   * Remove a session file. Only ever used to roll a *just created* fork back
   * when the step after it fails, so the daemon does not leave an orphan
   * transcript on disk that would later surface as an importable session.
   */
  deleteSession(sessionId: string): Promise<void>;
}

// On its own, the SDK looks for the session under the daemon's CLAUDE_CONFIG_DIR, while a
// provider can point Claude Code at another one. Forking through a store rooted at the
// transcript's folder reads the session where Claude Code wrote it and writes the fork beside it.
export const realClaudeRewindSdk: ClaudeRewindSdk = {
  forkSession: (sessionId, options) =>
    claudeForkSession(sessionId, {
      upToMessageId: options?.upToMessageId,
      ...(options?.transcriptPath
        ? { sessionStore: projectFolderSessionStore(path.dirname(options.transcriptPath)) }
        : {}),
    }),
  deleteSession: (sessionId) => claudeDeleteSession(sessionId),
};

/** SDK filesystem mutations otherwise resolve CLAUDE_CONFIG_DIR in the daemon. */
export function scopedClaudeRewindSdk(cwd: string, configDir: string): ClaudeRewindSdk {
  const projectDir = claudeProjectDirSync(cwd, { configDir });
  const store = projectFolderSessionStore(projectDir);
  return {
    forkSession: (sessionId, options) =>
      claudeForkSession(sessionId, {
        upToMessageId: options?.upToMessageId,
        dir: cwd,
        sessionStore: options?.transcriptPath
          ? projectFolderSessionStore(path.dirname(options.transcriptPath))
          : store,
      }),
    deleteSession: (sessionId) => claudeDeleteSession(sessionId, { dir: cwd, sessionStore: store }),
  };
}

function projectFolderSessionStore(projectFolder: string): SessionStore {
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
      return path.join(projectFolder, key.sessionId, key.subpath);
    }
    return path.join(projectFolder, `${key.sessionId}.jsonl`);
  }
  return {
    async load(key) {
      let text: string;
      try {
        text = await fs.readFile(entryPath(key), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      return parseTranscriptEntries(text);
    },
    async append(key, entries) {
      const target = entryPath(key);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.appendFile(target, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), {
        mode: 0o600,
      });
    },
    async delete(key) {
      await fs.rm(entryPath(key), { force: true });
    },
  };
}

function parseTranscriptEntries(text: string): SessionStoreEntry[] {
  const entries: SessionStoreEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Skip a line that is not JSON, as the SDK's own transcript reader does.
      continue;
    }
    if (isSessionStoreEntry(parsed)) entries.push(parsed);
  }
  return entries;
}

function isSessionStoreEntry(value: unknown): value is SessionStoreEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/**
 * The entry a message steered into a running turn follows. Claude Code gives such a message no
 * entry of its own: it records a queued_command attachment, under the uuid Paseo minted for the
 * message, hung off the entry it was read after. Forking at that entry drops the message and
 * everything after it. Null when the transcript holds no such attachment.
 */
export async function findSteeredMessageParent(
  transcriptPath: string,
  messageId: string,
): Promise<string | null> {
  const input = createReadStream(transcriptPath, { encoding: "utf8" });
  const lines = createInterface({
    input,
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      if (!line.includes(messageId) || !line.includes('"queued_command"')) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const record = entry as {
        type?: unknown;
        parentUuid?: unknown;
        attachment?: { type?: unknown; source_uuid?: unknown };
      };
      if (
        record.type === "attachment" &&
        record.attachment?.type === "queued_command" &&
        record.attachment.source_uuid === messageId &&
        typeof record.parentUuid === "string"
      ) {
        return record.parentUuid;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    lines.close();
    input.destroy();
  }
  return null;
}

export async function revertClaudeConversation(input: {
  sdk: ClaudeRewindSdk;
  sessionId: string | null;
  transcriptPath: string | null;
  messageId: string;
  resolveMessageId?: (messageId: string) => string | Promise<string>;
  setSessionId: (sessionId: string) => void | Promise<void>;
}): Promise<void> {
  if (!input.sessionId || !input.transcriptPath) {
    throw new Error("Claude session is not ready for rewind");
  }
  const messageId = (await input.resolveMessageId?.(input.messageId)) ?? input.messageId;
  const fork = await input.sdk.forkSession(input.sessionId, {
    upToMessageId: messageId,
    transcriptPath: input.transcriptPath,
  });
  await input.setSessionId(fork.sessionId);
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
  transcriptPath: string | null;
  messageId: string;
  resolveMessageId?: (messageId: string) => string | Promise<string>;
  setSessionId: (sessionId: string) => void | Promise<void>;
}): Promise<void> {
  await revertClaudeFiles({
    query: input.query,
    messageId: input.messageId,
    resolveMessageId: input.resolveMessageId,
  });
  await revertClaudeConversation(input);
}
