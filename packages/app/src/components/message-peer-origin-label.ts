import type { PeerMessageOrigin } from "@getpaseo/protocol/agent-types";
import { i18n } from "@/i18n/i18next";

/**
 * The sender authors its own name and address, so the label frames them as reported speech.
 */
export function getPeerMessageOriginLabel(origin: PeerMessageOrigin): string {
  const sender = origin.name ?? origin.address;
  if (!sender) return i18n.t("message.peer.fromUnknown");
  return i18n.t("message.peer.from", { sender });
}
