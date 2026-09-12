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
const NATIVE_FORK_PROVIDERS: ReadonlySet<string> = new Set<string>(["claude", "pi"]);

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
 * Lexically normalize a directory for the client-side hint.
 *
 * Collapses `.` segments, resolves `..`, drops repeated and trailing
 * separators and case-folds. It deliberately does NOT resolve symlinks: the
 * app may be running on a different machine from the daemon and has no access
 * to the daemon's filesystem, so it cannot realpath anything.
 *
 * Case-folding makes the hint slightly *optimistic* (two paths that differ only
 * in case are treated as the same directory, which is true on macOS and Windows
 * but not on a case-sensitive Linux filesystem). That direction is the safe
 * one: the daemon re-checks directory identity with realpath before it forks
 * and falls back with an explicit error if the directories really differ, so an
 * over-eager hint costs at most one refused request, while an under-eager hint
 * would silently downgrade the user to a cold-cache attachment fork with no way
 * to notice.
 */
function normalizeCwdHint(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const isAbsolute = trimmed.startsWith("/");
  const segments: string[] = [];
  for (const segment of trimmed.split(/[\\/]+/u)) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === ".." && segments.length > 0 && segments.at(-1) !== "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join("/").toLowerCase();
  return isAbsolute ? `/${joined}` : joined || null;
}

/**
 * A provider transcript is keyed by its project directory, so a fork that lands
 * in a different cwd could not resume the branched session even if the provider
 * supports branching. Same provider + same directory is therefore the exact
 * condition for the native path.
 *
 * The directory half of that test is only a HINT here — see
 * `normalizeCwdHint`. The daemon owns the real decision (`isSameDirectory` in
 * `fork-agent-session.ts`) because only it can realpath the paths.
 */
export function resolveForkMode(input: ResolveForkModeInput): ForkMode {
  if (!input.hostSupportsNativeFork) {
    return "attachment";
  }
  if (!providerSupportsNativeFork(input.provider)) {
    return "attachment";
  }
  const source = normalizeCwdHint(input.sourceCwd);
  const target = normalizeCwdHint(input.targetCwd);
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

/**
 * The i18n key describing what a fork of `mode` will actually carry.
 *
 * Kept next to `resolveForkMode` (and out of the menu component) so the promise
 * the UI makes is unit-testable against the same rules the fork follows:
 *
 * - an attachment fork renders the LIVE timeline, so it does include a turn
 *   that is still streaming;
 * - a native fork branches the provider's transcript. While a turn is in
 *   flight, that file does not contain it yet — and its `tool_use` blocks have
 *   no results — so the daemon cuts at the last COMPLETED turn and the menu
 *   says so instead of promising the reply on screen.
 */
export function forkModeDescriptionKey(input: { mode: ForkMode; inFlight: boolean }): string {
  if (input.mode !== "native") {
    return "message.actions.forkCopiesSummary";
  }
  return input.inFlight
    ? "message.actions.forkKeepsContextFromLastTurn"
    : "message.actions.forkKeepsContext";
}
