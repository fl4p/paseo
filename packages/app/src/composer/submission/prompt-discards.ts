import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export interface PromptDiscard {
  agentId: string;
  clientMessageId: string;
  reason: string;
}

/**
 * Listen for prompts the daemon discarded before they reached the provider. A discard is
 * addressed to the composer, not to a timeline: the pending submission for `clientMessageId` has
 * to be retired whether or not this session observes that agent's timeline, so it arrives as a
 * session event rather than through `observeTimeline`. A daemon delivers it to an event
 * subscriber in this form only, never also as the `prompt_discarded` agent_stream event.
 *
 * Only call this against a daemon that advertises `features.promptDiscardedEvents`: older
 * daemons reject an event subscription that names an event they do not know.
 */
export function observePromptDiscards(
  client: Pick<DaemonClient, "observeEvents">,
  onDiscard: (discard: PromptDiscard) => void,
): () => void {
  const observation = client.observeEvents(["agent_prompt_discarded"]);
  const unsubscribe = observation.subscribe({
    snapshot: () => {},
    update: (message) => {
      if (message.type !== "agent_prompt_discarded") return;
      const { agentId, clientMessageId, reason } = message.payload;
      onDiscard({ agentId, clientMessageId, reason });
    },
  });
  return () => {
    unsubscribe();
    void observation
      .release()
      .catch((error) => console.warn("[Session] Failed to release prompt discards", error));
  };
}
