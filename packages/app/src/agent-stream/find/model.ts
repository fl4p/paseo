import {
  flattenInlineMarkdown,
  TIMELINE_SEARCH_MATCH_LIMIT,
} from "@getpaseo/protocol/timeline-search";
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
  /** Which hit inside the row, counted in reading order from 0. */
  occurrence: number;
}

export interface TranscriptSearchResult {
  matches: TranscriptMatch[];
  /** The scan stopped at the limit, so `matches.length` is a floor, not a total. */
  truncated: boolean;
}

/** A hit the daemon found in timeline history, at the range of the message showing it. */
export interface HistoryMatch {
  seqStart: number;
  seqEnd: number;
  occurrence: number;
}

/** The daemon's answer for the whole timeline, loaded or not. */
export interface HistorySearchResult {
  epoch: string;
  matches: readonly HistoryMatch[];
  truncated: boolean;
}

/**
 * One hit the Find bar can count and step to: in a row the client has loaded,
 * or in history it has not loaded yet.
 */
export type TranscriptHit =
  | { kind: "loaded"; itemId: string; seq: number | null; occurrence: number }
  | { kind: "history"; seqStart: number; seqEnd: number; occurrence: number };

/**
 * The text the row actually shows. Rows whose body the transcript keeps
 * collapsed — tool output, plugin payloads — contribute only their visible
 * label, because a hit the reader cannot be scrolled to is worse than no hit.
 * Message text follows the same rules as the daemon's timeline search
 * (`@getpaseo/protocol/timeline-search`), so a hit found in unloaded history is
 * still a hit once that history loads.
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
export const TRANSCRIPT_MATCH_LIMIT = TIMELINE_SEARCH_MATCH_LIMIT;

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
    let occurrence = 0;
    while (start >= 0) {
      matches.push({ itemId: item.id, itemIndex, start, occurrence });
      if (matches.length >= limit) {
        return { matches, truncated: true };
      }
      occurrence += 1;
      // Overlapping hits ("aa" in "aaa") would otherwise loop forever on an
      // empty advance; a literal search reports non-overlapping occurrences.
      start = text.indexOf(query, start + query.length);
    }
  }

  return { matches, truncated: false };
}

/** Index of the first sorted value >= `min`, or `values.length`. */
function lowerBound(values: readonly number[], min: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((values[middle] ?? 0) < min) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * Every hit in reading order: hits in loaded rows as the stream model finds
 * them, and the daemon's hits for history that is not loaded.
 *
 * The loaded rows are authoritative wherever they exist — a live turn keeps
 * growing them after the daemon answered — so a history hit is kept only when
 * no loaded row falls inside its range. Loaded history need not be contiguous:
 * jumping far back merges a window into the transcript and leaves a gap between
 * it and the tail, and hits in that gap stay history hits.
 */
export function mergeTranscriptHits(input: {
  items: readonly StreamItem[];
  local: readonly TranscriptMatch[];
  history: HistorySearchResult | null;
}): TranscriptHit[] {
  const { items, local, history } = input;
  // A row without a cursor (a prompt not yet acknowledged) sorts where it sits,
  // after the last row that has one.
  const seqByIndex: Array<number | null> = [];
  const loadedSeqs: number[] = [];
  let carriedSeq: number | null = null;
  for (const item of items) {
    const cursor = item.timelineCursor;
    if (cursor && (history === null || cursor.epoch === history.epoch)) {
      carriedSeq = cursor.seq;
      loadedSeqs.push(cursor.seq);
    }
    seqByIndex.push(carriedSeq);
  }
  loadedSeqs.sort((left, right) => left - right);

  const loadedHits: TranscriptHit[] = local.map((match) => ({
    kind: "loaded",
    itemId: match.itemId,
    seq: items[match.itemIndex]?.id === match.itemId ? (seqByIndex[match.itemIndex] ?? null) : null,
    occurrence: match.occurrence,
  }));
  if (history === null) {
    return loadedHits;
  }

  const historyHits = history.matches
    .filter((match) => {
      const firstInRange = loadedSeqs[lowerBound(loadedSeqs, match.seqStart)];
      return firstInRange === undefined || firstInRange > match.seqEnd;
    })
    .sort((left, right) => left.seqEnd - right.seqEnd || left.occurrence - right.occurrence);

  const merged: TranscriptHit[] = [];
  let loadedAt = 0;
  for (const match of historyHits) {
    // Loaded hits at or before this history position come first.
    while (loadedAt < loadedHits.length && sortSeq(loadedHits[loadedAt]) <= match.seqEnd) {
      merged.push(loadedHits[loadedAt] as TranscriptHit);
      loadedAt += 1;
    }
    merged.push({ kind: "history", ...match });
  }
  for (; loadedAt < loadedHits.length; loadedAt += 1) {
    merged.push(loadedHits[loadedAt] as TranscriptHit);
  }
  return merged;
}

function sortSeq(hit: TranscriptHit | undefined): number {
  if (!hit) {
    return Number.POSITIVE_INFINITY;
  }
  return hit.kind === "loaded" ? (hit.seq ?? Number.NEGATIVE_INFINITY) : hit.seqEnd;
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

function inRange(seq: number | null, range: { seqStart: number; seqEnd: number }): boolean {
  return seq !== null && seq >= range.seqStart && seq <= range.seqEnd;
}

/** The hit a new search starts on: the first one already loaded, which is where the reader is. */
function startingHit(hits: readonly TranscriptHit[]): number {
  const loaded = hits.findIndex((hit) => hit.kind === "loaded");
  return loaded >= 0 ? loaded : 0;
}

/**
 * Keeps the reader on the same hit while the list changes underneath them. A
 * live turn appends rows; loading history turns a history hit into a loaded
 * one; loading a window far back can unload the rows the reader left. The same
 * hit is found again across all of these by row and occurrence, then by row.
 */
export function preserveActiveHit(input: {
  previous: TranscriptHit | null;
  hits: readonly TranscriptHit[];
}): number {
  const { previous, hits } = input;
  if (!previous || hits.length === 0) {
    return startingHit(hits);
  }

  const sameRow = (hit: TranscriptHit): boolean => {
    if (previous.kind === "loaded") {
      if (hit.kind === "loaded") {
        return hit.itemId === previous.itemId;
      }
      return inRange(previous.seq, hit);
    }
    if (hit.kind === "loaded") {
      return inRange(hit.seq, previous);
    }
    return hit.seqEnd === previous.seqEnd;
  };

  const sameHit = hits.findIndex((hit) => sameRow(hit) && hit.occurrence === previous.occurrence);
  if (sameHit >= 0) {
    return sameHit;
  }
  const row = hits.findIndex(sameRow);
  return row >= 0 ? row : startingHit(hits);
}
