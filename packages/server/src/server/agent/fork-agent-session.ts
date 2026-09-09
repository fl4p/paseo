import type { Logger } from "pino";

import type { AgentProvider } from "./agent-sdk-types.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import { resolveForkBoundaryMessageId } from "./activity-curator.js";
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
  loadAgent(agentId: string): Promise<{ cwd: string; workspaceId: string | undefined }>;
  /** Read the source agent's timeline, used only to resolve a boundary. */
  fetchTimeline(agentId: string): { epoch: string; rows: readonly AgentTimelineRow[] };
  /** Branch the provider session; returns the new provider-level handle. */
  forkProviderSession(
    agentId: string,
    input: { boundaryMessageId: string | null },
  ): Promise<{ providerHandleId: string; provider: AgentProvider; cwd: string }>;
  /** Register the branched provider session as a new paseo agent. */
  importProviderSession(input: {
    provider: AgentProvider;
    providerHandleId: string;
    cwd: string;
    workspaceId: string | undefined;
    requestId: string;
  }): Promise<{
    agentId: string;
    timelineSize: number;
    createdWorkspace: PersistedWorkspaceRecord | null;
  }>;
  registerCreatedWorkspace(workspace: PersistedWorkspaceRecord): Promise<void>;
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
 * Extracted from the session handler so it can be driven with fakes: the whole
 * point of the feature is what comes back on the new agent's timeline, and that
 * is unobservable from a handler wired to a live provider.
 */
export async function forkAgentSessionNatively(
  request: ForkAgentSessionRequest,
  deps: ForkAgentSessionDeps,
): Promise<ForkAgentSessionResult> {
  const source = await deps.loadAgent(request.agentId);
  const cwd = request.cwd?.trim() || source.cwd;
  if (cwd !== source.cwd) {
    // A provider transcript is keyed by its project directory. Resuming the
    // branch somewhere else would look for it in a store that does not have it,
    // so refuse rather than silently produce an empty agent.
    throw new Error("Native fork requires the same working directory as the source agent");
  }

  const boundaryMessageId = resolveBoundary(request, deps);
  const fork = await deps.forkProviderSession(request.agentId, { boundaryMessageId });
  const imported = await deps.importProviderSession({
    provider: fork.provider,
    providerHandleId: fork.providerHandleId,
    cwd,
    workspaceId: request.workspaceId ?? source.workspaceId,
    requestId: request.requestId,
  });
  if (imported.createdWorkspace) {
    await deps.registerCreatedWorkspace(imported.createdWorkspace);
  }
  deps.logger.info(
    {
      agentId: request.agentId,
      forkedAgentId: imported.agentId,
      providerHandleId: fork.providerHandleId,
      boundaryMessageId,
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
