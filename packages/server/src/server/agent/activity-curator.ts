import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { isLikelyExternalToolName } from "@getpaseo/protocol/tool-name-normalization";
import { buildToolCallDisplayModel } from "@getpaseo/protocol/tool-call-display";
import { projectTimelineRows } from "./timeline-projection.js";

const DEFAULT_MAX_ITEMS = 0;
const MAX_TOOL_INPUT_CHARS = 400;
const MAX_TOOL_SUMMARY_CHARS = 200;

interface ActivityCuratorOptions {
  maxItems?: number;
  labelAssistantMessages?: boolean;
  includeKinds?: readonly AgentTimelineItem["type"][];
  includeExternalToolInput?: boolean;
}

interface ActivityEntry {
  text: string;
}

type TextAgentAttachment = Extract<AgentAttachment, { type: "text" }>;

function appendText(buffer: string, text: string): string {
  const normalized = text.trim();
  if (!normalized) {
    return buffer;
  }
  if (!buffer) {
    return normalized;
  }
  return `${buffer}\n${normalized}`;
}

function activityEntry(text: string): ActivityEntry {
  return { text };
}

function flushBuffers(
  entries: ActivityEntry[],
  buffers: { message: string; thought: string },
  options?: ActivityCuratorOptions,
) {
  if (buffers.message.trim()) {
    const text = buffers.message.trim();
    entries.push(activityEntry(options?.labelAssistantMessages ? `[Assistant] ${text}` : text));
  }
  if (buffers.thought.trim()) {
    const text = buffers.thought.trim();
    entries.push(activityEntry(`[Thought] ${text}`));
  }
  buffers.message = "";
  buffers.thought = "";
}

function formatToolInputJson(input: unknown): string | null {
  if (input === undefined) {
    return null;
  }
  try {
    const encoded = JSON.stringify(input);
    if (!encoded) {
      return null;
    }
    if (encoded.length <= MAX_TOOL_INPUT_CHARS) {
      return encoded;
    }
    return `${encoded.slice(0, MAX_TOOL_INPUT_CHARS)}...`;
  } catch {
    return null;
  }
}

function formatToolSummary(summary: string | undefined): string | null {
  if (typeof summary !== "string") {
    return null;
  }
  const normalized = summary.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= MAX_TOOL_SUMMARY_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_TOOL_SUMMARY_CHARS - 3)}...`;
}

function inputFromUnknownDetail(
  detail: Extract<AgentTimelineItem, { type: "tool_call" }>["detail"],
): unknown {
  return detail.type === "unknown" ? detail.input : null;
}

function projectForCuration(items: readonly AgentTimelineItem[]): AgentTimelineItem[] {
  const rows = items.map((item, index) => ({
    seq: index + 1,
    timestamp: "",
    item,
  }));
  return projectTimelineRows({ rows, mode: "projected" }).map((entry) => entry.item);
}

function shouldIncludeItem(item: AgentTimelineItem, options?: ActivityCuratorOptions): boolean {
  if (!options?.includeKinds) {
    return true;
  }
  return options.includeKinds.includes(item.type);
}

function formatToolCallEntry(
  item: Extract<AgentTimelineItem, { type: "tool_call" }>,
  options?: ActivityCuratorOptions,
): ActivityEntry {
  const inputJson = formatToolInputJson(inputFromUnknownDetail(item.detail));
  const display = buildToolCallDisplayModel({
    name: item.name,
    status: item.status,
    error: item.error,
    detail: item.detail,
    metadata: item.metadata,
  });
  const displayName = display.displayName;
  const summary = formatToolSummary(display.summary);
  if (
    (options?.includeExternalToolInput ?? true) &&
    isLikelyExternalToolName(item.name) &&
    inputJson
  ) {
    return activityEntry(`[${displayName}] ${inputJson}`);
  }
  return activityEntry(summary ? `[${displayName}] ${summary}` : `[${displayName}]`);
}

function curateProjectedActivityEntries(
  items: readonly AgentTimelineItem[],
  options?: ActivityCuratorOptions,
): ActivityEntry[] {
  if (items.length === 0) {
    return [];
  }

  const maxItems = options?.maxItems ?? DEFAULT_MAX_ITEMS;
  const recentItems = maxItems > 0 && items.length > maxItems ? items.slice(-maxItems) : items;

  const entries: ActivityEntry[] = [];
  const buffers = { message: "", thought: "" };

  for (const item of recentItems) {
    if (!shouldIncludeItem(item, options)) {
      continue;
    }

    switch (item.type) {
      case "user_message":
        flushBuffers(entries, buffers, options);
        entries.push(activityEntry(`[User] ${item.text.trim()}`));
        break;
      case "assistant_message":
        buffers.message = appendText(buffers.message, item.text);
        break;
      case "reasoning":
        buffers.thought = appendText(buffers.thought, item.text);
        break;
      case "tool_call": {
        flushBuffers(entries, buffers, options);
        entries.push(formatToolCallEntry(item, options));
        if (item.detail.type === "sub_agent" && item.detail.log.trim()) {
          entries.push(activityEntry(item.detail.log.trim()));
        }
        break;
      }
      case "todo":
        flushBuffers(entries, buffers, options);
        entries.push(activityEntry("[Tasks]"));
        for (const entry of item.items) {
          const checkbox = entry.completed ? "[x]" : "[ ]";
          const text = `- ${checkbox} ${entry.text}`;
          entries.push(activityEntry(text));
        }
        break;
      case "error":
        flushBuffers(entries, buffers, options);
        entries.push(activityEntry(`[Error] ${item.message}`));
        break;
      case "compaction":
        flushBuffers(entries, buffers, options);
        entries.push(activityEntry("[Compacted]"));
        break;
    }
  }

  flushBuffers(entries, buffers, options);

  return entries;
}

function curateAgentActivityEntries(
  timeline: AgentTimelineItem[],
  options?: ActivityCuratorOptions,
): ActivityEntry[] {
  const collapsed = projectForCuration(timeline);
  return curateProjectedActivityEntries(collapsed, options);
}

/**
 * Convert normalized agent timeline items into a concise text summary.
 */
export function curateAgentActivity(
  timeline: AgentTimelineItem[],
  options?: ActivityCuratorOptions,
): string {
  const entries = curateAgentActivityEntries(timeline, options);
  return entries.length > 0
    ? entries.map((entry) => entry.text).join("\n")
    : "No activity to display.";
}

interface ForkCursorBoundary {
  timelineEpoch: string;
  cursor: { epoch: string; seq: number };
}

/**
 * Character budget for the text-attachment fork. The attachment is re-sent as
 * the first user message of a brand-new session, so an unbounded blob both
 * re-inflates history the source session had already compacted away and blows
 * past the target model's context. 60k characters is roughly 15k tokens — a
 * fraction of any current context window, and small enough that the fork does
 * not start out already compacting.
 */
const DEFAULT_FORK_CONTEXT_MAX_CHARS = 60_000;

/** Body marker standing where entries were dropped. */
const FORK_CONTEXT_OMISSION_MARKER = "[… earlier history omitted to fit the context budget …]";
/** Body marker closing an entry that was cut short. */
const FORK_CONTEXT_ENTRY_TRUNCATION_MARKER = "[… message truncated to fit the context budget …]";
/**
 * Header notes. They point at the inline markers rather than repeating them,
 * so a reader can tell an omission from a truncation and each marker is
 * emitted in exactly one place.
 */
const FORK_CONTEXT_OMITTED_NOTE =
  "Some earlier history was omitted to fit the context budget; the gap is marked inline.";
const FORK_CONTEXT_ENTRY_TRUNCATED_NOTE =
  "Long messages were cut short to fit the context budget; each cut is marked inline.";
const FORK_CONTEXT_COMPACTION_MARKER =
  "[… history before the source session's last compaction omitted …]";

function findForkBoundaryIndex(input: {
  rows: readonly AgentTimelineRow[];
  cursorBoundary?: ForkCursorBoundary | null;
  boundaryMessageId?: string | null;
}): number | null {
  const boundaryCursor = input.cursorBoundary?.cursor ?? null;
  const boundaryMessageId = input.boundaryMessageId?.trim() || null;
  if (!boundaryCursor && !boundaryMessageId) {
    return null;
  }
  if (
    input.cursorBoundary &&
    input.cursorBoundary.cursor.epoch !== input.cursorBoundary.timelineEpoch
  ) {
    throw new Error("Selected timeline position is no longer available.");
  }
  const boundaryIndex = boundaryCursor
    ? input.rows.findIndex((row) => row.seq === boundaryCursor.seq)
    : input.rows.findLastIndex(
        (row) => row.item.type === "assistant_message" && row.item.messageId === boundaryMessageId,
      );
  if (boundaryIndex < 0) {
    throw new Error(
      boundaryCursor
        ? "Selected timeline position is no longer available."
        : "Selected assistant message is no longer available.",
    );
  }
  return boundaryIndex;
}

/**
 * Resolve the provider-visible message id a fork boundary points at.
 *
 * The native fork needs a single message id to hand the provider, but a cursor
 * can land on any row (a tool call, a todo update). Walk backwards from the
 * boundary to the nearest row that actually carries a message id — that is the
 * last message the provider knows about at or before the selected position.
 * Returns `null` when no boundary was requested (fork the whole session).
 */
export function resolveForkBoundaryMessageId(input: {
  rows: readonly AgentTimelineRow[];
  cursorBoundary?: ForkCursorBoundary | null;
  boundaryMessageId?: string | null;
}): string | null {
  const boundaryIndex = findForkBoundaryIndex(input);
  if (boundaryIndex === null) {
    return null;
  }
  for (let index = boundaryIndex; index >= 0; index -= 1) {
    const row = input.rows[index];
    if (!row) {
      continue;
    }
    const item = row.item;
    if (
      (item.type === "assistant_message" || item.type === "user_message") &&
      typeof item.messageId === "string" &&
      item.messageId.length > 0
    ) {
      return item.messageId;
    }
  }
  throw new Error("Selected timeline position has no provider message to fork from.");
}

/**
 * Index of the last completed compaction at or before `endIndex`, or -1.
 *
 * Everything before it is history the provider has already summarized away;
 * replaying it into a fork is exactly the re-inflation this attachment path
 * used to cause.
 */
function findLastCompletedCompactionIndex(
  rows: readonly AgentTimelineRow[],
  endIndex: number,
): number {
  for (let index = Math.min(endIndex, rows.length - 1); index >= 0; index -= 1) {
    const item = rows[index]?.item;
    if (item?.type === "compaction" && item.status === "completed") {
      return index;
    }
  }
  return -1;
}

function selectForkContextRows(input: {
  rows: readonly AgentTimelineRow[];
  cursorBoundary?: ForkCursorBoundary | null;
  boundaryMessageId?: string | null;
}): {
  items: AgentTimelineItem[];
  boundaryCursor: { epoch: string; seq: number } | null;
  boundaryMessageId: string | null;
  startedAtCompaction: boolean;
} {
  const boundaryIndex = findForkBoundaryIndex(input);
  const endIndex = boundaryIndex ?? input.rows.length - 1;
  const compactionIndex = findLastCompletedCompactionIndex(input.rows, endIndex);
  const startIndex = compactionIndex >= 0 ? compactionIndex + 1 : 0;
  const selectedRows = input.rows.slice(startIndex, endIndex + 1);
  const projected = projectTimelineRows({ rows: selectedRows, mode: "projected" });

  return {
    items: projected.map((entry) => entry.item),
    boundaryCursor: input.cursorBoundary?.cursor ?? null,
    boundaryMessageId: input.boundaryMessageId?.trim() || null,
    startedAtCompaction: compactionIndex >= 0,
  };
}

/**
 * Trim rendered entries to `maxChars`.
 *
 * Three things this has to get right, each of which it previously did not:
 *
 * - the cap is a cap. An entry that does not fit is truncated with a marker,
 *   never kept whole, so no single oversized message can blow past `maxChars`;
 * - the opening user message survives, because losing the original task
 *   statement reliably makes a fork useless;
 * - the newest entry survives, because on a bounded fork that is the message
 *   the user picked as the boundary. Dropping it silently forks at a point the
 *   user did not choose.
 *
 * What was dropped or cut is marked inline, and the caller turns the two flags
 * into a header that says which of the two actually happened.
 */
function applyForkContextBudget(
  entries: readonly ActivityEntry[],
  maxChars: number,
): { entries: ActivityEntry[]; omitted: boolean; truncatedEntries: boolean } {
  const joinedLength = entries.reduce((total, entry) => total + entry.text.length + 1, 0);
  if (maxChars <= 0 || joinedLength <= maxChars) {
    return { entries: [...entries], omitted: false, truncatedEntries: false };
  }

  const first = entries[0];
  const head = first && first.text.startsWith("[User] ") ? first : null;
  const lastIndex = entries.length - 1;
  const last = entries[lastIndex] && entries[lastIndex] !== head ? entries[lastIndex]! : null;
  const middleStart = head ? 1 : 0;
  const middleEnd = last ? lastIndex - 1 : lastIndex;
  const middleCount = middleEnd - middleStart + 1;
  // The gap marker is part of the body, so it has to be paid for out of the
  // same budget it announces.
  const markerCost = middleCount > 0 ? FORK_CONTEXT_OMISSION_MARKER.length + 1 : 0;

  const pinned = fitPinnedEntries(head, last, Math.max(0, maxChars - markerCost));
  const middle = collectForkContextTail(entries, {
    from: middleEnd,
    to: middleStart,
    budget: Math.max(0, maxChars - markerCost - pinned.used),
  });
  const omitted = middle.length < middleCount;

  return {
    entries: [
      ...(pinned.head ? [pinned.head] : []),
      ...(omitted ? [activityEntry(FORK_CONTEXT_OMISSION_MARKER)] : []),
      ...middle,
      ...(pinned.last ? [pinned.last] : []),
    ],
    omitted,
    truncatedEntries: pinned.truncatedEntries,
  };
}

/**
 * Fit the two pinned entries — the opening task and the newest/selected message
 * — into `budget`, truncating rather than dropping either. When both are too
 * big they split the budget; when only one is, it may use whatever the other
 * left behind.
 */
function fitPinnedEntries(
  head: ActivityEntry | null,
  last: ActivityEntry | null,
  budget: number,
): {
  head: ActivityEntry | null;
  last: ActivityEntry | null;
  used: number;
  truncatedEntries: boolean;
} {
  const headCost = head ? head.text.length + 1 : 0;
  const lastCost = last ? last.text.length + 1 : 0;
  if (headCost + lastCost <= budget) {
    return { head, last, used: headCost + lastCost, truncatedEntries: false };
  }
  const share = (mine: number, other: number): number => {
    const half = Math.floor(budget / 2);
    return mine <= half ? mine : Math.max(half, budget - other);
  };
  const headCap = head && last ? share(headCost, lastCost) : budget;
  const lastCap = head && last ? share(lastCost, headCost) : budget;
  const fittedHead = fitEntry(head, headCap);
  const fittedLast = fitEntry(last, lastCap);
  return {
    head: fittedHead.entry,
    last: fittedLast.entry,
    used: fittedHead.cost + fittedLast.cost,
    truncatedEntries: fittedHead.truncated || fittedLast.truncated,
  };
}

/** Fit one entry into `cost` characters (text plus its newline), or drop it. */
function fitEntry(
  entry: ActivityEntry | null,
  cost: number,
): { entry: ActivityEntry | null; cost: number; truncated: boolean } {
  if (!entry) {
    return { entry: null, cost: 0, truncated: false };
  }
  if (entry.text.length + 1 <= cost) {
    return { entry, cost: entry.text.length + 1, truncated: false };
  }
  const cap = cost - 1;
  if (cap <= FORK_CONTEXT_ENTRY_TRUNCATION_MARKER.length) {
    // Not even the marker fits: the budget is too small for this entry to say
    // anything, so drop it rather than emit a stub that breaks the cap.
    return { entry: null, cost: 0, truncated: true };
  }
  const kept = entry.text.slice(0, cap - FORK_CONTEXT_ENTRY_TRUNCATION_MARKER.length);
  return {
    entry: activityEntry(`${kept}${FORK_CONTEXT_ENTRY_TRUNCATION_MARKER}`),
    cost: cap + 1,
    truncated: true,
  };
}

/**
 * Collect entries backwards from the newest, keeping the run contiguous: the
 * first entry that does not fit ends the walk, and everything before it is
 * announced by the gap marker.
 */
function collectForkContextTail(
  entries: readonly ActivityEntry[],
  window: { from: number; to: number; budget: number },
): ActivityEntry[] {
  const tail: ActivityEntry[] = [];
  let used = 0;
  for (let index = window.from; index >= window.to; index -= 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    const cost = entry.text.length + 1;
    if (used + cost > window.budget) {
      break;
    }
    used += cost;
    tail.unshift(entry);
  }
  return tail;
}

function trimContextMetadata(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function buildForkContextText(input: {
  body: string;
  agentTitle?: string | null;
  cwd?: string | null;
  startedAtCompaction: boolean;
  omitted: boolean;
  truncatedEntries: boolean;
}): string {
  const header = ["Chat history from a previous Paseo agent."];
  const agentTitle = trimContextMetadata(input.agentTitle);
  const cwd = trimContextMetadata(input.cwd);
  if (agentTitle) {
    header.push(`Source agent: ${agentTitle}`);
  }
  if (cwd) {
    header.push(`Source directory: ${cwd}`);
  }
  if (input.startedAtCompaction) {
    header.push(FORK_CONTEXT_COMPACTION_MARKER);
  }
  if (input.omitted) {
    header.push(FORK_CONTEXT_OMITTED_NOTE);
  }
  if (input.truncatedEntries) {
    header.push(FORK_CONTEXT_ENTRY_TRUNCATED_NOTE);
  }
  return `<chat-history-summary>\n${header.join("\n")}\n\n${input.body}\n</chat-history-summary>`;
}

export function buildAgentForkContextAttachment(input: {
  rows: readonly AgentTimelineRow[];
  cursorBoundary?: ForkCursorBoundary | null;
  boundaryMessageId?: string | null;
  agentTitle?: string | null;
  cwd?: string | null;
  maxChars?: number;
}): {
  attachment: TextAgentAttachment;
  itemCount: number;
  boundaryCursor: { epoch: string; seq: number } | null;
  boundaryMessageId: string | null;
} {
  const selected = selectForkContextRows({
    rows: input.rows,
    cursorBoundary: input.cursorBoundary,
    boundaryMessageId: input.boundaryMessageId,
  });
  const curated = curateProjectedActivityEntries(selected.items, {
    maxItems: 0,
    labelAssistantMessages: true,
    includeKinds: ["user_message", "assistant_message", "tool_call"],
    includeExternalToolInput: false,
  });
  const budgeted = applyForkContextBudget(
    curated,
    input.maxChars ?? DEFAULT_FORK_CONTEXT_MAX_CHARS,
  );
  const body =
    budgeted.entries.length > 0
      ? budgeted.entries.map((entry) => entry.text).join("\n")
      : "No chat history to display.";
  return {
    attachment: {
      type: "text",
      mimeType: "text/plain",
      contextKind: "chat_history",
      title: "Chat history",
      text: buildForkContextText({
        body,
        agentTitle: input.agentTitle,
        cwd: input.cwd,
        startedAtCompaction: selected.startedAtCompaction,
        omitted: budgeted.omitted,
        truncatedEntries: budgeted.truncatedEntries,
      }),
    },
    itemCount: selected.items.length,
    boundaryCursor: selected.boundaryCursor,
    boundaryMessageId: selected.boundaryMessageId,
  };
}
