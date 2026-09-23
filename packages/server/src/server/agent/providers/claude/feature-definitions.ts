import type { AgentFeature, AgentFeatureToggle } from "../../agent-sdk-types.js";
import { claudeAccountFeature, type ClaudeAccount } from "./accounts.js";
import { claudeManifestModelSupportsFastMode } from "./model-manifest.js";
import { claudeServedModelSupportsFastMode } from "./served-catalog.js";

export const CLAUDE_FAST_MODE_FEATURE: Omit<AgentFeatureToggle, "value"> = {
  type: "toggle",
  id: "fast_mode",
  label: "Fast",
  description: "Lower latency Opus responses at higher token cost",
  tooltip: "Toggle fast mode",
  icon: "zap",
};

export function claudeModelSupportsFastMode(modelId: string | null | undefined): boolean {
  // The manifest first, so a model it ships never loses the toggle to a cache read that failed.
  return claudeManifestModelSupportsFastMode(modelId) || claudeServedModelSupportsFastMode(modelId);
}

export function buildClaudeFeatures(input: {
  modelId: string | null | undefined;
  fastModeEnabled: boolean;
  accounts?: ClaudeAccount[];
  account?: unknown;
}): AgentFeature[] {
  const accounts = claudeAccountFeature(input.accounts ?? [], input.account);
  if (!claudeModelSupportsFastMode(input.modelId)) {
    return accounts;
  }

  return [
    ...accounts,
    {
      ...CLAUDE_FAST_MODE_FEATURE,
      value: input.fastModeEnabled,
    },
  ];
}
