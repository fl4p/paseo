/**
 * Transcript Find hits are painted with the CSS Custom Highlight API, which only
 * the web has (see `highlight.web.ts`). Native has no find bar, so these do
 * nothing.
 */

export const FIND_HIGHLIGHT = "paseo-find";
export const FIND_ACTIVE_HIGHLIGHT = "paseo-find-active";

export interface ActiveTranscriptHit {
  itemId: string;
  /** Which hit inside that row, counted in reading order from 0. */
  occurrence: number;
}

export interface TranscriptHighlightResult {
  count: number;
  activeRange: Range | null;
}

export function findTextRanges(_root: unknown, _query: string): Range[] {
  return [];
}

export function applyTranscriptHighlights(_input: {
  query: string;
  active: ActiveTranscriptHit | null;
  root?: unknown;
}): TranscriptHighlightResult {
  return { count: 0, activeRange: null };
}

export function clearTranscriptHighlights(): void {}

export function revealRange(_range: Range): boolean {
  return false;
}

export function afterRowSettles(_itemId: string, callback: () => void): () => void {
  callback();
  return () => undefined;
}
