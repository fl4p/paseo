import type { AgentTimelineItem } from "./agent-types.js";

export function timelineItemIdentity(item: AgentTimelineItem): string | null {
  if (item.type === "tool_call") return item.callId;
  if (item.type === "plugin") return `${item.pluginId}/${item.id}`;
  if (item.type === "user_message" && (item.messageId || item.clientMessageId)) {
    return `user_message:${item.clientMessageId ?? item.messageId}`;
  }
  return null;
}
