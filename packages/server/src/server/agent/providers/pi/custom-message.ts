import type { PiAgentMessage } from "./rpc-types.js";

type PiCustomMessage = Extract<PiAgentMessage, { role: "custom" }>;

/**
 * Pi extensions inject context-only custom messages — the plan-mode prompt is
 * re-injected on every turn via `before_agent_start` — and mark them
 * `display: false`. Those must stay out of the timeline; anything else (plan
 * todo lists, plan completion, execute handoffs) is meant to be shown.
 */
export function shouldDisplayPiCustomMessage(message: PiCustomMessage): boolean {
  return Reflect.get(message, "display") !== false;
}
