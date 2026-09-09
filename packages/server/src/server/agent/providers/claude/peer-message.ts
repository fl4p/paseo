import type { PeerMessageOrigin } from "@getpaseo/protocol/agent-types";

/**
 * Claude Code delivers a message from one of your other sessions as a user entry, both on the live
 * stream and in the transcript. Verified on the wire (Claude Code 2.1.x over the UDS transport):
 *
 *   type      "user"
 *   isMeta    true
 *   content   "Another Claude session sent a message:\n<cross-session-message …>…"
 *   origin    kind "peer", from, name, fromMode, body, verifiedPeerPid
 *
 * `isMeta` is what Claude marks every injected entry with, from system reminders to hook output, so
 * the generic synthetic filter drops these too. `origin.kind` is the discriminator that separates a
 * peer's message from that noise, and `origin.body` is the message without the envelope the prompt
 * text wraps around it — the SDK documents it as byte-exact with what the model saw.
 *
 * `from` and `name` are authored by the sender (the SDK keys real identity on a kernel-verified pid
 * it does not forward), so both are display attribution and never a permission.
 */
export interface ClaudePeerMessage {
  text: string;
  origin: PeerMessageOrigin;
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
