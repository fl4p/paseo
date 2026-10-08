import MarkdownIt from "markdown-it";
import { setImmediate } from "node:timers/promises";
import {
  findTextOccurrences,
  TIMELINE_SEARCH_MATCH_LIMIT,
  timelineItemSearchText,
} from "@getpaseo/protocol/timeline-search";
import type { AgentTimelineRow } from "../agent-timeline-store-types.js";
import { projectTimelineRows } from "../timeline-projection.js";

const markdown = new MarkdownIt({ html: false });
const PAGE_SIZE = 200;
interface SearchLocation {
  seq: number;
  role: "user" | "assistant";
  count: number;
}
/**
 * `messages` (the default) is what chat find can step to: user and assistant
 * messages only. `transcript` is what the transcript Find bar matches in its
 * loaded rows — reasoning, tasks, notices and errors too — using the shared
 * `@getpaseo/protocol/timeline-search` text rules, so a hit found in loaded rows
 * is still found once those rows are unloaded, and with the same count.
 */
export type TimelineSearchScope = "messages" | "transcript";
interface SearchInput {
  rows: readonly AgentTimelineRow[];
  query: string;
  cursor?: number;
  scope?: TimelineSearchScope;
  /** Rows the requesting client can render; a hit in any other row could never be shown. */
  include?: (item: AgentTimelineRow["item"]) => boolean;
}

// Discovery is deliberately approximate. Only the client can verify displayed text, so
// `count` estimates rendered occurrences and the client replaces it with the rendered
// count once the message is on screen. Blocks are counted separately, and the Markdown
// source is never searched whole, because a match the client cannot highlight — across
// a block boundary, or on syntax the reader never sees — still inflates the total until
// navigation reaches that message and drops it.
function searchableBlocks(text: string): string[] {
  return markdown
    .parse(text, {})
    .map((token) => {
      if (token.type === "inline") {
        return (token.children ?? [])
          .map((child) => {
            if (child.type === "text" || child.type === "code_inline") return child.content;
            if (child.type === "softbreak" || child.type === "hardbreak") return "\n";
            return "";
          })
          .join("");
      }
      if (token.type === "fence" || token.type === "code_block") return token.content;
      return "";
    })
    .filter(Boolean);
}

function searchPattern(query: string): RegExp {
  const source = query
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return new RegExp(source, "giu");
}

function countMatches(text: string, pattern: RegExp): number {
  let count = 0;
  for (const _ of text.matchAll(pattern)) count += 1;
  return count;
}

function countMessageMatches(item: AgentTimelineRow["item"], pattern: RegExp): number {
  if (item.type !== "user_message" && item.type !== "assistant_message") return 0;
  const raw = item.text.replace(/\r/g, "");
  const blocks = item.type === "assistant_message" ? searchableBlocks(raw) : [raw];
  return blocks.reduce((sum, block) => sum + countMatches(block, pattern), 0);
}

// Literal and case-insensitive over the item's visible text, exactly as the app's
// `findTranscriptMatches` scans a loaded row.
function countTranscriptMatches(item: AgentTimelineRow["item"], query: string): number {
  return findTextOccurrences(timelineItemSearchText(item), query, TIMELINE_SEARCH_MATCH_LIMIT)
    .length;
}

export async function searchTimeline({
  rows,
  query,
  cursor = 0,
  scope = "messages",
  include,
}: SearchInput) {
  const locations: SearchLocation[] = [];
  const transcript = scope === "transcript";
  if (transcript ? !query : !query.trim()) return { locations, nextCursor: null };
  const pattern = transcript ? null : searchPattern(query);
  let lastYield = performance.now();
  for (const entry of projectTimelineRows({ rows, mode: "projected" })) {
    if (entry.seqEnd <= cursor) continue;
    const item = entry.item;
    let count = 0;
    if (!include || include(item)) {
      count = pattern ? countMessageMatches(item, pattern) : countTranscriptMatches(item, query);
    }
    if (count) {
      if (locations.length === PAGE_SIZE) {
        return { locations, nextCursor: locations[PAGE_SIZE - 1]!.seq };
      }
      locations.push({
        seq: entry.seqEnd,
        // The wire role is user|assistant; reasoning, tasks and notices are the agent's
        // side of the turn. Only the transcript scope returns them, and its caller
        // steps by seq, not by role.
        role: item.type === "user_message" ? "user" : "assistant",
        count,
      });
    }
    if (performance.now() - lastYield >= 8) {
      await setImmediate();
      lastYield = performance.now();
    }
  }
  return { locations, nextCursor: null };
}
