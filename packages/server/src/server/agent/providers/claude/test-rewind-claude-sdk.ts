import type { ClaudeRewindSdk } from "./rewind.js";

export class FakeClaudeSdk implements ClaudeRewindSdk {
  readonly recordedForks: Array<{ upToMessageId: string | undefined }> = [];
  /** Full argument capture, including the source session id. */
  readonly recordedForkCalls: Array<{
    sessionId: string;
    upToMessageId: string | undefined;
  }> = [];
  readonly recordedFileRewinds: Array<{ userMessageId: string }> = [];
  readonly recordedDeletes: string[] = [];

  /** When set, `deleteSession` rejects with this error instead of recording. */
  deleteSessionError: Error | null = null;

  private nextSessionId = "forked-session-1";

  setNextSessionId(sessionId: string): void {
    this.nextSessionId = sessionId;
  }

  async forkSession(
    sessionId: string,
    options?: { upToMessageId?: string },
  ): Promise<{ sessionId: string }> {
    this.recordedForks.push({ upToMessageId: options?.upToMessageId });
    this.recordedForkCalls.push({ sessionId, upToMessageId: options?.upToMessageId });
    return { sessionId: this.nextSessionId };
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (this.deleteSessionError) {
      throw this.deleteSessionError;
    }
    this.recordedDeletes.push(sessionId);
  }

  createQuery(): {
    rewindFiles: (
      userMessageId: string,
      options?: { dryRun?: boolean },
    ) => Promise<{
      canRewind: boolean;
    }>;
  } {
    return {
      rewindFiles: async (userMessageId: string) => {
        this.recordedFileRewinds.push({ userMessageId });
        return { canRewind: true };
      },
    };
  }
}
