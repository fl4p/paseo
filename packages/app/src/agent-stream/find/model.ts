import type { StreamItem } from "@/types/stream";

/**
 * A literal, case-insensitive hit inside one transcript row.
 *
 * Matches are found in the loaded stream model rather than the DOM: the web
 * transcript only mounts its recent rows (see `web-virtualization.ts`), so a
 * DOM search silently misses most of a long conversation.
 */
export interface TranscriptMatch {
  itemId: string;
  itemIndex: number;
  /**
   * Offset into the row's *searchable* text — lowercased and flattened, so it
   * is not an index into the original body. It identifies a hit; it is not
   * usable for highlighting the source without recomputing the mapping.
   */
  start: number;
}

export interface TranscriptSearchResult {
  matches: TranscriptMatch[];
  /** The scan stopped at the limit, so `matches.length` is a floor, not a total. */
  truncated: boolean;
}

/**
 * Message bodies are rendered as Markdown, so the reader sees `hello world`
 * where the source says `hello **world**`. Searching the source would miss the
 * phrase they are looking at, so inline markers are flattened first. This is
 * deliberately not a Markdown parser: it removes the inline syntax that splits
 * a visible phrase, and leaves everything else alone.
 */
export function flattenInlineMarkdown(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    .replace(/(\*\*\*|___)(.+?)\1/g, "$2")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(?<![\w*])([*_])(?!\s)(.+?)(?<!\s)\1(?![\w*])/g, "$2")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "");
}

/**
 * The text the row actually shows. Rows whose body the transcript keeps
 * collapsed — tool output, plugin payloads — contribute only their visible
 * label, because a hit the reader cannot be scrolled to is worse than no hit.
 */
export function getSearchableText(item: StreamItem): string {
  switch (item.kind) {
    case "user_message":
    case "assistant_message":
    case "thought":
      return flattenInlineMarkdown(item.text);
    case "notification":
      return item.message;
    case "todo_list":
      // A running task shows its active form in place of its text.
      return item.items
        .map((entry) =>
          entry.status === "in_progress" && entry.activeForm ? entry.activeForm : entry.text,
        )
        .join("\n");
    case "tool_call":
      return item.payload.source === "agent" ? item.payload.data.name : item.payload.data.toolName;
    default:
      return "";
  }
}

/** Above this the count stops being useful and the work stops being cheap. */
export const TRANSCRIPT_MATCH_LIMIT = 5000;

export function findTranscriptMatches(input: {
  items: readonly StreamItem[];
  query: string;
  limit?: number;
}): TranscriptSearchResult {
  const query = input.query.toLowerCase();
  if (query.length === 0) {
    return { matches: [], truncated: false };
  }

  const limit = input.limit ?? TRANSCRIPT_MATCH_LIMIT;
  const matches: TranscriptMatch[] = [];

  for (const [itemIndex, item] of input.items.entries()) {
    const text = getSearchableText(item).toLowerCase();
    if (text.length < query.length) {
      continue;
    }
    let start = text.indexOf(query);
    while (start >= 0) {
      matches.push({ itemId: item.id, itemIndex, start });
      if (matches.length >= limit) {
        return { matches, truncated: true };
      }
      // Overlapping hits ("aa" in "aaa") would otherwise loop forever on an
      // empty advance; a literal search reports non-overlapping occurrences.
      start = text.indexOf(query, start + query.length);
    }
  }

  return { matches, truncated: false };
}

/**
 * Where the next/previous button lands. Wraps in both directions, and keeps the
 * caller from having to special-case an empty match list.
 */
export function stepMatchIndex(input: {
  current: number;
  total: number;
  forward: boolean;
}): number {
  if (input.total <= 0) {
    return 0;
  }
  const next = input.forward ? input.current + 1 : input.current - 1;
  return ((next % input.total) + input.total) % input.total;
}

/**
 * Keeps the reader on the same hit while the transcript grows underneath them.
 * A live turn appends rows, which would otherwise renumber the active match.
 */
export function preserveActiveMatch(input: {
  previous: TranscriptMatch | null;
  matches: readonly TranscriptMatch[];
}): number {
  const { previous, matches } = input;
  if (!previous || matches.length === 0) {
    return 0;
  }
  const sameHit = matches.findIndex(
    (match) => match.itemId === previous.itemId && match.start === previous.start,
  );
  if (sameHit >= 0) {
    return sameHit;
  }
  const sameRow = matches.findIndex((match) => match.itemId === previous.itemId);
  return sameRow >= 0 ? sameRow : 0;
}
