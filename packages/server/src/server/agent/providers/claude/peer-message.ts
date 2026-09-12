import type { PeerMessageOrigin } from "@getpaseo/protocol/agent-types";

/**
 * Claude Code delivers a message from one of your other sessions on two different carriers, and
 * only the transcript gets the user entry. Verified on the wire (Claude Code 2.1.269 over the UDS
 * transport, receiving session driven with --input-format stream-json):
 *
 *   transcript   type "user", isMeta true, origin, and the envelope prose in message.content
 *   live stream  NO user frame at all — the peer text reaches the host only as `origin` on the
 *                `result` frame that ends the turn the message started
 *
 * A peer's message is the PROMPT of the turn it starts, and Claude Code does not echo prompts back
 * on the stream — the host is assumed to know what it submitted. Nobody submitted this one, so a
 * host that reads user frames alone shows the reply and never the message, until a history reload
 * replays the transcript entry.
 *
 * `isMeta` is what Claude marks every injected entry with, from system reminders to hook output, so
 * the generic synthetic filter drops these too. `origin.kind` is the discriminator that separates a
 * peer's message from that noise, and `origin.body` is the message without the envelope the prompt
 * text wraps around it — the SDK documents it as byte-exact with what the model saw. `origin.msg_id`
 * is the sender's id for the delivery and is the SAME on both carriers, which is what lets the live
 * frame and the replayed entry resolve to one timeline item instead of two.
 *
 * `from` and `name` are authored by the sender (the SDK keys real identity on a kernel-verified pid
 * it does not forward), so both are display attribution and never a permission.
 */
export interface ClaudePeerMessage {
  text: string;
  origin: PeerMessageOrigin;
  /** The sender's delivery id, shared by the live frame and the transcript entry. */
  msgId: string | null;
}

export function readClaudePeerMessage(entry: unknown): ClaudePeerMessage | null {
  const record = asRecord(entry);
  if (!record) {
    return null;
  }
  const origin = asRecord(record.origin);
  if (origin?.kind !== "peer") {
    return null;
  }
  const text = readString(origin.body) ?? readMessageText(record.message);
  if (!text) {
    return null;
  }
  const name = readString(origin.name);
  const address = readString(origin.from);
  return {
    text,
    msgId: readString(origin.msg_id),
    origin: {
      kind: "peer",
      ...(name ? { name } : {}),
      ...(address ? { address } : {}),
    },
  };
}

function readMessageText(message: unknown): string | null {
  const record = asRecord(message);
  if (!record) {
    return null;
  }
  return readString(record.content);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
