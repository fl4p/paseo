/**
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
const navigateToWorkspace = vi.fn();
const setWorkspaceAttachments = vi.fn();
const setDraftSetup = vi.fn();

vi.mock("expo-router", () => ({ useRouter: () => ({ push }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/stores/navigation-active-workspace-store", () => ({ navigateToWorkspace }));
vi.mock("@/stores/draft-keys", () => ({ generateDraftId: () => "draft-1" }));
vi.mock("@/attachments/workspace-attachments-store", () => ({
  buildDraftWorkspaceAttachmentScopeKey: (draftId: string) => `draft:${draftId}`,
  useWorkspaceAttachmentsStore: { getState: () => ({ setWorkspaceAttachments }) },
}));
vi.mock("@/stores/workspace-draft-submission-store", () => ({
  useWorkspaceDraftSubmissionStore: { getState: () => ({ setDraftSetup }) },
}));
vi.mock("@/utils/host-routes", () => ({ buildNewWorkspaceRoute: () => "/new-workspace" }));

const hostFeatures: Record<string, boolean> = {};
vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (_serverId: string, feature: string) => hostFeatures[feature] === true,
}));

const client = {
  forkAgentSession: vi.fn(async () => ({
    requestId: "req-1",
    agentId: "agent-source",
    forkedAgentId: "agent-forked",
    providerHandleId: "claude-session-2",
    timelineSize: 4,
    error: null,
  })),
  buildAgentForkContext: vi.fn(async () => ({
    requestId: "req-1",
    agentId: "agent-source",
    attachment: { type: "text", mimeType: "text/plain", text: "history" },
    itemCount: 2,
    boundaryMessageId: null,
    boundaryCursor: null,
    error: null,
  })),
};
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({ sessions: { "server-a": { client } } }),
}));

const { useForkAgent } = await import("./use-fork-agent");
type ForkAgentSource = Parameters<ReturnType<typeof useForkAgent>>[0]["agent"];

function agentSource(overrides: Partial<ForkAgentSource> = {}): ForkAgentSource {
  return {
    provider: "claude",
    cwd: "/repo",
    currentModeId: null,
    model: null,
    thinkingOptionId: null,
    runtimeInfo: null,
    features: [],
    projectPlacement: null,
    ...overrides,
  } as ForkAgentSource;
}

function forkAgent() {
  return renderHook(() => useForkAgent({ serverId: "server-a" })).result.current;
}

describe("useForkAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hostFeatures.agentForkContext = true;
    hostFeatures.agentForkSession = true;
  });

  it("forks natively into a new tab for the same provider and directory", async () => {
    await forkAgent()({
      agentId: "agent-source",
      agent: agentSource(),
      workspaceId: "ws-1",
      target: "tab",
      boundary: { boundaryMessageId: "assistant-1" },
    });

    expect(client.forkAgentSession).toHaveBeenCalledWith("agent-source", {
      boundaryMessageId: "assistant-1",
      cwd: "/repo",
      workspaceId: "ws-1",
    });
    // The native fork produces a real agent, so it opens that agent — there is
    // no composer draft and no chat-history attachment to seed.
    expect(navigateToWorkspace).toHaveBeenCalledWith({
      serverId: "server-a",
      workspaceId: "ws-1",
      target: { kind: "agent", agentId: "agent-forked" },
    });
    expect(client.buildAgentForkContext).not.toHaveBeenCalled();
    expect(setWorkspaceAttachments).not.toHaveBeenCalled();
  });

  it("uses the attachment fork for a different provider", async () => {
    await forkAgent()({
      agentId: "agent-source",
      agent: agentSource({ provider: "codex" }),
      workspaceId: "ws-1",
      target: "tab",
    });

    expect(client.forkAgentSession).not.toHaveBeenCalled();
    expect(client.buildAgentForkContext).toHaveBeenCalled();
    expect(setWorkspaceAttachments).toHaveBeenCalled();
    expect(navigateToWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.objectContaining({ kind: "draft" }) }),
    );
  });

  it("uses the attachment fork for a new workspace, whose directory is not fixed yet", async () => {
    await forkAgent()({
      agentId: "agent-source",
      agent: agentSource(),
      workspaceId: "ws-1",
      target: "workspace",
    });

    expect(client.forkAgentSession).not.toHaveBeenCalled();
    expect(client.buildAgentForkContext).toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/new-workspace");
  });

  it("uses the attachment fork when the daemon has no native fork", async () => {
    hostFeatures.agentForkSession = false;

    await forkAgent()({
      agentId: "agent-source",
      agent: agentSource(),
      workspaceId: "ws-1",
      target: "tab",
    });

    expect(client.forkAgentSession).not.toHaveBeenCalled();
    expect(client.buildAgentForkContext).toHaveBeenCalled();
  });

  it("reports a native fork failure instead of silently opening nothing", async () => {
    client.forkAgentSession.mockRejectedValueOnce(new Error("fork exploded"));
    const toast = { error: vi.fn(), success: vi.fn(), info: vi.fn() };

    await renderHook(() =>
      useForkAgent({ serverId: "server-a", toast: toast as never }),
    ).result.current({
      agentId: "agent-source",
      agent: agentSource(),
      workspaceId: "ws-1",
      target: "tab",
    });

    expect(toast.error).toHaveBeenCalledWith("fork exploded");
    expect(navigateToWorkspace).not.toHaveBeenCalled();
  });
});
