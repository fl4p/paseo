import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { AssistantForkTarget } from "@/components/assistant-fork-menu";

/**
 * How a fork will carry the source conversation into the new agent.
 *
 * - `native` — the daemon branches the provider's own session file. The fork
 *   replays the same message prefix, so the prompt cache stays warm and any
 *   compaction the provider already performed is inherited rather than
 *   re-expanded.
 * - `attachment` — the daemon renders the transcript into a text attachment
 *   that seeds a brand-new session. Works across providers and directories,
 *   but the new session starts cold and pays for the history again.
 */
export type ForkMode = "native" | "attachment";

/** Providers whose session store can branch (see `AgentClient.forkProviderSession`). */
const NATIVE_FORK_PROVIDERS: ReadonlySet<string> = new Set<string>(["claude"]);

export function providerSupportsNativeFork(provider: AgentProvider | null | undefined): boolean {
  return typeof provider === "string" && NATIVE_FORK_PROVIDERS.has(provider);
}

export interface ResolveForkModeInput {
  /** Daemon advertises `features.agentForkSession`. */
  hostSupportsNativeFork: boolean;
  provider: AgentProvider | null | undefined;
  sourceCwd: string | null | undefined;
  /**
   * Directory the fork will run in, or `null` when it is not fixed yet (the
   * "new workspace" target lets the user pick a directory, and a worktree
   * checkout gets its own path).
   */
  targetCwd: string | null | undefined;
}

/**
 * A provider transcript is keyed by its project directory, so a fork that lands
 * in a different cwd could not resume the branched session even if the provider
 * supports branching. Same provider + same directory is therefore the exact
 * condition for the native path.
 */
export function resolveForkMode(input: ResolveForkModeInput): ForkMode {
  if (!input.hostSupportsNativeFork) {
    return "attachment";
  }
  if (!providerSupportsNativeFork(input.provider)) {
    return "attachment";
  }
  const source = input.sourceCwd?.trim();
  const target = input.targetCwd?.trim();
  if (!source || !target || source !== target) {
    return "attachment";
  }
  return "native";
}

/**
 * The directory a fork target lands in, or `null` when it is not known at
 * decision time. A new tab reuses the source agent's workspace and therefore
 * its directory; a new workspace does not.
 */
export function resolveForkTargetCwd(input: {
  target: AssistantForkTarget;
  sourceCwd: string | null | undefined;
}): string | null {
  return input.target === "tab" ? input.sourceCwd?.trim() || null : null;
}
