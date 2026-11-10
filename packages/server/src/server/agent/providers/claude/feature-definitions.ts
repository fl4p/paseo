import type { AgentOptionControl, AgentOptionToggleControl } from "../../agent-sdk-types.js";
import { claudeAccountControl, type ClaudeAccount } from "./accounts.js";
import { claudeManifestModelSupportsFastMode } from "./model-manifest.js";
import { claudeServedModelSupportsFastMode } from "./served-catalog.js";

export const CLAUDE_FAST_MODE_CONTROL: AgentOptionToggleControl = {
  type: "toggle",
  key: "fast_mode",
  label: "Fast",
  description: "Lower latency responses at higher token cost",
  tooltip: "Toggle fast mode",
  icon: "zap",
};

export function claudeModelSupportsFastMode(modelId: string | null | undefined): boolean {
  // The manifest first, so a model it ships never loses the toggle to a cache read that failed.
  return claudeManifestModelSupportsFastMode(modelId) || claudeServedModelSupportsFastMode(modelId);
}

export function buildClaudeControls(
  modelId: string | null | undefined,
  accounts: ClaudeAccount[] = [],
): AgentOptionControl[] {
  return [
    ...claudeAccountControl(accounts),
    ...(claudeModelSupportsFastMode(modelId) ? [{ ...CLAUDE_FAST_MODE_CONTROL }] : []),
  ];
}
