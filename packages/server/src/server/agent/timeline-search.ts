import {
  findTextOccurrences,
  TIMELINE_SEARCH_MATCH_LIMIT,
  timelineItemSearchText,
} from "@getpaseo/protocol/timeline-search";
import type { TimelineProjectionEntry } from "./timeline-projection.js";

export interface TimelineSearchMatch {
  seqStart: number;
  seqEnd: number;
  /** Which hit inside the entry, counted in reading order from 0. */
  occurrence: number;
}

export interface TimelineSearchResult {
  matches: TimelineSearchMatch[];
  /** The scan stopped at the limit, so `matches.length` is a floor, not a total. */
  truncated: boolean;
}

/**
 * Searches projected timeline entries — the units the app renders as one
 * message each — rather than raw rows. A phrase split across streamed chunks is
 * then still one hit, and a hit's `seqEnd` is the timeline position the app
 * gives the message that shows it, which is how the app finds it again after
 * loading that window.
 */
export function searchTimelineEntries(
  entries: readonly TimelineProjectionEntry[],
  query: string,
  requestedLimit?: number,
): TimelineSearchResult {
  const limit =
    requestedLimit !== undefined && requestedLimit > 0
      ? Math.min(requestedLimit, TIMELINE_SEARCH_MATCH_LIMIT)
      : TIMELINE_SEARCH_MATCH_LIMIT;
  const matches: TimelineSearchMatch[] = [];
  if (query.length === 0) {
    return { matches, truncated: false };
  }

  for (const entry of entries) {
    // Ask for one more than fits, so a cap reached exactly is not reported as a floor.
    const starts = findTextOccurrences(
      timelineItemSearchText(entry.item),
      query,
      limit - matches.length + 1,
    );
    for (let occurrence = 0; occurrence < starts.length; occurrence += 1) {
      if (matches.length >= limit) {
        return { matches, truncated: true };
      }
      matches.push({ seqStart: entry.seqStart, seqEnd: entry.seqEnd, occurrence });
    }
  }
  return { matches, truncated: false };
}
