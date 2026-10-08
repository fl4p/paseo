import { expect, test, vi } from "vitest";
import { DaemonClient, type DaemonTransport } from "@getpaseo/client/internal/daemon-client";
import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { observePromptDiscards, type PromptDiscard } from "./prompt-discards";

function fixture() {
  const requests: SessionInboundMessage[] = [];
  let receive!: (data: unknown, isBinary: boolean) => void;
  let open!: () => void;
  let next = 0;
  let eventsSubscriptionId: string | undefined;
  const reply = (message: SessionOutboundMessage) =>
    receive(JSON.stringify({ type: "session", message }), false);
  const transport: DaemonTransport = {
    send(data) {
      if (typeof data !== "string") throw new Error("No binary request expected");
      const frame = JSON.parse(data);
      if (frame.type === "ping") receive(JSON.stringify({ type: "pong" }), false);
      if (frame.type !== "session") return;
      requests.push(frame.message);
      if (frame.message.type === "agent.timeline.set_subscription.request")
        reply({
          type: "agent.timeline.set_subscription.response",
          payload: {
            requestId: frame.message.requestId,
            agentIds: frame.message.agentIds,
            subscriptionId: `timeline-${++next}`,
          },
        });
      if (frame.message.type === "session.events.set_subscription.request")
        reply({
          type: "session.events.set_subscription.response",
          payload: {
            requestId: frame.message.requestId,
            subscriptionId: (eventsSubscriptionId = `events-${++next}`),
          },
        });
      if (frame.message.type === "subscription.release.request")
        reply({
          type: "subscription.release.response",
          payload: {
            requestId: frame.message.requestId,
            subscriptionId: frame.message.subscriptionId,
          },
        });
    },
    close() {},
    onMessage(handler) {
      receive = handler;
      return () => {};
    },
    onOpen(handler) {
      open = handler;
      return () => {};
    },
    onClose() {
      return () => {};
    },
    onError() {
      return () => {};
    },
  };
  const client = new DaemonClient({
    url: "ws://prompt-discards",
    clientId: "prompt-discards",
    transportFactory: () => transport,
    reconnect: { enabled: false },
  });
  const connect = async () => {
    const connected = client.connect();
    open();
    reply({
      type: "status",
      payload: {
        status: "server_info",
        serverId: "prompt-discards",
        hostname: null,
        version: null,
        features: { ownedSubscriptions: true, promptDiscardedEvents: true },
      },
    });
    await connected;
  };
  return { client, requests, reply, connect, eventsSubscriptionId: () => eventsSubscriptionId };
}

test("a prompt discarded on an agent whose timeline is not observed reaches the composer once", async () => {
  const { client, requests, reply, connect, eventsSubscriptionId } = fixture();
  try {
    await connect();
    const timeline = client.observeTimeline(["agent-viewed"]);
    const timelineMessages: unknown[] = [];
    timeline.subscribe({ snapshot: () => {}, update: (message) => timelineMessages.push(message) });
    const discards: PromptDiscard[] = [];
    const stop = observePromptDiscards(client, (discard) => discards.push(discard));
    await timeline.ready;
    expect(
      requests.find((request) => request.type === "session.events.set_subscription.request"),
    ).toMatchObject({ events: ["agent_prompt_discarded"] });
    await vi.waitFor(() => expect(eventsSubscriptionId()).toBeDefined());
    // Let the acknowledgement settle so its subscription ID routes the update.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const subscriptionId = eventsSubscriptionId()!;

    reply({
      type: "agent_prompt_discarded",
      payload: {
        subscriptionId,
        agentId: "agent-elsewhere",
        clientMessageId: "client-message-1",
        reason: "Message not sent: the agent was closed",
      },
    });

    expect(discards).toEqual([
      {
        agentId: "agent-elsewhere",
        clientMessageId: "client-message-1",
        reason: "Message not sent: the agent was closed",
      },
    ]);
    expect(timelineMessages).toEqual([]);

    stop();
    await vi.waitFor(() =>
      expect(requests.at(-1)).toMatchObject({
        type: "subscription.release.request",
        subscriptionId,
      }),
    );
    await timeline.release();
  } finally {
    await client.close();
  }
});
