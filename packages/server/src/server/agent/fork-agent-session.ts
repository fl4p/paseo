import type { Logger } from "pino";

import type { AgentProvider, AgentSessionConfig } from "./agent-sdk-types.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import { resolveForkBoundaryMessageId } from "./activity-curator.js";
import { createRealpathAwarePathMatcher } from "../../utils/path.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

export interface ForkAgentSessionRequest {
  agentId: string;
  requestId: string;
  boundaryCursor?: { epoch: string; seq: number };
  boundaryMessageId?: string;
  cwd?: string;
  workspaceId?: string;
}

export interface ForkAgentSessionDeps {
  /** Load (resuming if needed) the agent being forked. */
  loadAgent(agentId: string): Promise<{
    cwd: string;
    workspaceId: string | undefined;
    config: AgentSessionConfig;
  }>;
  /** Read the source agent's timeline, used only to resolve a boundary. */
  fetchTimeline(agentId: string): { epoch: string; rows: readonly AgentTimelineRow[] };
  /**
   * Is a turn running on the source agent right now? A fork taken then reads a
   * transcript that is still being appended to, so it must be cut at the last
   * completed turn rather than at the end of the file.
   */
  hasInFlightRun(agentId: string): boolean;
  /**
   * Everything that can be checked BEFORE the irreversible provider fork:
   * the directory still exists, and the requested workspace (and its project)
   * is present, unarchived and points at that directory. Throwing here means
   * no provider session is created at all.
   */
  validateForkTarget(input: { cwd: string; workspaceId: string | undefined }): Promise<void>;
  /** Branch the provider session; returns the new provider-level handle. */
  forkProviderSession(
    agentId: string,
    input: { boundaryMessageId: string | null; atCompletedTurn: boolean },
  ): Promise<{ providerHandleId: string; provider: AgentProvider; cwd: string }>;
  /** Register the branched provider session as a new paseo agent. */
  importProviderSession(input: {
    provider: AgentProvider;
    providerHandleId: string;
    cwd: string;
    workspaceId: string | undefined;
    requestId: string;
    /** Source-agent settings the fork must start from. See `inheritedForkConfig`. */
    config: Partial<AgentSessionConfig>;
  }): Promise<{
    agentId: string;
    timelineSize: number;
    createdWorkspace: PersistedWorkspaceRecord | null;
  }>;
  registerCreatedWorkspace(workspace: PersistedWorkspaceRecord): Promise<void>;
  /**
   * Undo `forkProviderSession`. Best effort: the caller reports the original
   * failure, so a rollback that fails is logged and swallowed.
   */
  deleteForkedProviderSession(agentId: string, input: { providerHandleId: string }): Promise<void>;
  logger: Logger;
}

export interface ForkAgentSessionResult {
  agentId: string;
  providerHandleId: string;
  timelineSize: number;
}

/**
 * Fork an agent at the provider level.
 *
 * Branch the provider's own session file, then import the branch as a new
 * agent. Because the branch replays the source transcript, the new agent keeps
 * the source message prefix — the prompt cache is a prefix match over
 * `tools -> system -> messages`, so it stays warm — and inherits whatever
 * compaction the provider already performed instead of re-inflating the
 * pre-compaction history the way the text-attachment fork does.
 *
 * Matching `messages` is not enough for that cache: `tools` and `system` are
 * the earlier halves of the same prefix, so the fork also carries the source
 * agent's settings into the import instead of re-deriving them from the
 * daemon's current defaults (see `inheritedForkConfig`).
 *
 * Extracted from the session handler so it can be driven with fakes: the whole
 * point of the feature is what comes back on the new agent's timeline, and that
 * is unobservable from a handler wired to a live provider.
 */
export async function forkAgentSessionNatively(
  request: ForkAgentSessionRequest,
  deps: ForkAgentSessionDeps,
): Promise<ForkAgentSessionResult> {
  const source = await deps.loadAgent(request.agentId);
  const requestedCwd = request.cwd?.trim();
  if (requestedCwd && !isSameDirectory(source.cwd, requestedCwd)) {
    // A provider transcript is keyed by its project directory. Resuming the
    // branch somewhere else would look for it in a store that does not have it,
    // so refuse rather than silently produce an empty agent.
    throw new Error("Native fork requires the same working directory as the source agent");
  }
  // Always import under the source agent's own spelling of the directory: the
  // request may name the same directory through a symlink, a trailing
  // separator or a different case, and the provider store is keyed by the
  // canonical one.
  const cwd = source.cwd;

  const workspaceId = request.workspaceId ?? source.workspaceId;
  const boundaryMessageId = resolveBoundary(request, deps);
  // Last point at which nothing has happened yet. Everything below this line
  // has to be rolled back by hand.
  await deps.validateForkTarget({ cwd, workspaceId });

  // A fork requested mid-turn cannot include the turn that is still streaming:
  // both this reader and the SDK take a snapshot of a file the provider is
  // appending to, so the visible tail may be half-written and its tool calls
  // may have no results yet. Cutting at the last completed turn is also what
  // serializes the fork against the writer -- everything appended after the cut
  // is excluded by construction, so no lock is needed and none is taken.
  const atCompletedTurn = !boundaryMessageId && deps.hasInFlightRun(request.agentId);
  const fork = await deps.forkProviderSession(request.agentId, {
    boundaryMessageId,
    atCompletedTurn,
  });
  const imported = await withForkRollback(request.agentId, fork.providerHandleId, deps, () =>
    importForkedSession({ deps, fork, cwd, workspaceId, request, config: source.config }),
  );
  deps.logger.info(
    {
      agentId: request.agentId,
      forkedAgentId: imported.agentId,
      providerHandleId: fork.providerHandleId,
      boundaryMessageId,
      atCompletedTurn,
      timelineSize: imported.timelineSize,
    },
    "agent.fork_session.complete",
  );
  return {
    agentId: imported.agentId,
    providerHandleId: fork.providerHandleId,
    timelineSize: imported.timelineSize,
  };
}

/**
 * The part of the source agent's stored config a fork must start from.
 *
 * The prompt cache is a prefix match over `tools -> system -> messages`, so a
 * fork that reuses the transcript but re-derives its tools and system prompt
 * from today's daemon defaults starts COLD — which is most of the point of the
 * native fork. Anything that shapes that prefix is therefore inherited:
 *
 * - `model`, `thinkingOptionId`: the request the prefix is cached against;
 * - `modeId`: the permission mode, which also changes what the agent may do;
 * - `systemPrompt`, `mcpServers`, `toolPolicy`, `providerOptions`,
 *   `featureValues`: the `tools` and `system` halves of the prefix.
 *
 * Deliberately NOT inherited, because they name the source rather than describe
 * how it runs:
 *
 * - `provider`, `cwd`: come from the fork itself (and the fork is refused when
 *   the directory differs);
 * - `title`: the fork gets its own, derived from its imported timeline;
 * - `internal`: the fork is a user-visible agent created by a user action, even
 *   when the source was an internal system agent;
 * - `daemonAppendSystemPrompt`: deliberately never persisted, so the daemon's
 *   current value applies.
 *
 * Workspace identity, agent id and timestamps are minted by the import.
 */
export function inheritedForkConfig(config: AgentSessionConfig): Partial<AgentSessionConfig> {
  const inherited: Partial<AgentSessionConfig> = {};
  const copy = <Key extends keyof AgentSessionConfig>(key: Key): void => {
    const value = config[key];
    if (value !== undefined) {
      inherited[key] = value;
    }
  };
  copy("model");
  copy("modeId");
  copy("thinkingOptionId");
  copy("systemPrompt");
  copy("providerOptions");
  copy("toolPolicy");
  copy("mcpServers");
  copy("featureValues");
  return inherited;
}

/**
 * Do two cwd strings name the same directory?
 *
 * String equality is the wrong test: `/repo/`, `/repo/./`, a symlinked path and
 * a differently cased path on a case-insensitive filesystem all name the same
 * directory, and rejecting them would force a needless attachment fork with a
 * cold prompt cache. `createRealpathAwarePathMatcher` compares realpath
 * variants as well as the literal strings, so distinct git worktrees — whose
 * real paths genuinely differ — still fall back.
 *
 * This is the authoritative check. The client's `resolveForkMode` runs a
 * cheap lexical version of it as a hint, because the app may be on a different
 * machine and cannot realpath the daemon's filesystem.
 */
function isSameDirectory(left: string, right: string): boolean {
  return createRealpathAwarePathMatcher(left)(right);
}

async function importForkedSession(input: {
  deps: ForkAgentSessionDeps;
  fork: { providerHandleId: string; provider: AgentProvider };
  cwd: string;
  workspaceId: string | undefined;
  request: ForkAgentSessionRequest;
  config: AgentSessionConfig;
}): Promise<{ agentId: string; timelineSize: number }> {
  const imported = await input.deps.importProviderSession({
    provider: input.fork.provider,
    providerHandleId: input.fork.providerHandleId,
    cwd: input.cwd,
    workspaceId: input.workspaceId,
    requestId: input.request.requestId,
    config: inheritedForkConfig(input.config),
  });
  if (imported.createdWorkspace) {
    await input.deps.registerCreatedWorkspace(imported.createdWorkspace);
  }
  return { agentId: imported.agentId, timelineSize: imported.timelineSize };
}

/**
 * Run the steps that follow the irreversible provider fork, deleting the fork
 * if any of them fails.
 *
 * Without this a failed import (missing cwd, absent or archived workspace,
 * failed hydration) answers the client with an error and no paseo agent, while
 * a brand-new provider transcript stays on disk — where the importable-session
 * list later offers it to the user as if they had created it.
 *
 * The rollback is best effort and never masks the failure that triggered it:
 * a rollback error is logged and dropped, and the ORIGINAL error is what the
 * caller sees.
 */
async function withForkRollback<T>(
  agentId: string,
  providerHandleId: string,
  deps: ForkAgentSessionDeps,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    try {
      await deps.deleteForkedProviderSession(agentId, { providerHandleId });
      deps.logger.warn(
        { err: error, agentId, providerHandleId },
        "agent.fork_session.rolled_back: deleted the forked provider session after a failure",
      );
    } catch (rollbackError) {
      deps.logger.error(
        { err: rollbackError, cause: error, agentId, providerHandleId },
        "agent.fork_session.rollback_failed: an orphan provider session may remain on disk",
      );
    }
    throw error;
  }
}

function resolveBoundary(
  request: ForkAgentSessionRequest,
  deps: ForkAgentSessionDeps,
): string | null {
  if (!request.boundaryCursor && !request.boundaryMessageId) {
    return null;
  }
  const timeline = deps.fetchTimeline(request.agentId);
  return resolveForkBoundaryMessageId({
    rows: timeline.rows,
    cursorBoundary: request.boundaryCursor
      ? { timelineEpoch: timeline.epoch, cursor: request.boundaryCursor }
      : null,
    boundaryMessageId: request.boundaryMessageId,
  });
}
