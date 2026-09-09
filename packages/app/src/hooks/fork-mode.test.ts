import { describe, expect, it } from "vitest";
import { providerSupportsNativeFork, resolveForkMode, resolveForkTargetCwd } from "./fork-mode";

const CWD = "/Users/dev/project";

function resolve(overrides: Partial<Parameters<typeof resolveForkMode>[0]> = {}) {
  return resolveForkMode({
    hostSupportsNativeFork: true,
    provider: "claude",
    sourceCwd: CWD,
    targetCwd: CWD,
    ...overrides,
  });
}

describe("resolveForkMode", () => {
  it("uses the native path for the same provider in the same directory", () => {
    expect(resolve()).toBe("native");
  });

  it("falls back to the attachment for a different provider", () => {
    // Only Claude's session store can branch; everything else has to re-send
    // the conversation as text.
    expect(resolve({ provider: "codex" })).toBe("attachment");
    expect(resolve({ provider: "opencode" })).toBe("attachment");
    expect(resolve({ provider: null })).toBe("attachment");
  });

  it("falls back to the attachment for a different directory", () => {
    // A provider transcript is keyed by its project directory, so a fork that
    // lands elsewhere could not resume the branch.
    expect(resolve({ targetCwd: "/Users/dev/project-worktree" })).toBe("attachment");
  });

  it("falls back to the attachment when the target directory is not decided yet", () => {
    expect(resolve({ targetCwd: null })).toBe("attachment");
    expect(resolve({ targetCwd: "   " })).toBe("attachment");
  });

  it("falls back to the attachment when the source directory is unknown", () => {
    expect(resolve({ sourceCwd: null })).toBe("attachment");
  });

  it("falls back to the attachment when the daemon does not advertise the feature", () => {
    // An older daemon has no `agent.fork_session.request` handler at all.
    expect(resolve({ hostSupportsNativeFork: false })).toBe("attachment");
  });
});

describe("resolveForkTargetCwd", () => {
  it("keeps the source directory for a new tab in the same workspace", () => {
    expect(resolveForkTargetCwd({ target: "tab", sourceCwd: CWD })).toBe(CWD);
  });

  it("leaves a new-workspace fork undecided", () => {
    // The user picks the directory (and a worktree gets its own path) after the
    // menu closes, so the mode cannot be promised as native here.
    expect(resolveForkTargetCwd({ target: "workspace", sourceCwd: CWD })).toBeNull();
  });

  it("reports an unknown source directory as undecided", () => {
    expect(resolveForkTargetCwd({ target: "tab", sourceCwd: "  " })).toBeNull();
    expect(resolveForkTargetCwd({ target: "tab", sourceCwd: undefined })).toBeNull();
  });
});

describe("providerSupportsNativeFork", () => {
  it("recognizes only providers whose session store can branch", () => {
    expect(providerSupportsNativeFork("claude")).toBe(true);
    expect(providerSupportsNativeFork("codex")).toBe(false);
    expect(providerSupportsNativeFork(undefined)).toBe(false);
  });
});
