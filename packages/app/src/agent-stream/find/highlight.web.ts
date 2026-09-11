import { baseColors } from "@/styles/theme";

/**
 * Paints transcript Find hits with the CSS Custom Highlight API.
 *
 * Chromium's find painted its own matches, but it also counted the find field
 * and pulled focus out of it, so the transcript is searched through its stream
 * model instead, and that search has to paint its hits itself. A highlight
 * registry marks text ranges without touching the DOM or focus, and only rows of
 * the transcript are searched, so the find field can never match itself. The
 * ranges come from the rendered text, so a phrase the reader sees is found even
 * when Markdown splits it across elements.
 */

export const FIND_HIGHLIGHT = "paseo-find";
export const FIND_ACTIVE_HIGHLIGHT = "paseo-find-active";

const STYLE_ID = "paseo-find-highlight-style";
const ROW_SELECTOR = "[data-history-row-id]";
const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT"]);
const REVEAL_MARGIN_PX = 24;
const SETTLE_STABLE_FRAMES = 3;
const SETTLE_MAX_FRAMES = 60;

export interface ActiveTranscriptHit {
  itemId: string;
  /** Which hit inside that row, counted in reading order from 0. */
  occurrence: number;
}

export interface TranscriptHighlightResult {
  count: number;
  activeRange: Range | null;
}

function rgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function highlightApiAvailable(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight === "function"
  );
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  // Translucent, so the same rule reads on light and dark surfaces.
  style.textContent =
    `::highlight(${FIND_HIGHLIGHT}){background-color:${rgba(baseColors.yellow[400], 0.4)};}` +
    `::highlight(${FIND_ACTIVE_HIGHLIGHT}){background-color:${rgba(baseColors.amber[500], 0.75)};}`;
  document.head.appendChild(style);
}

/**
 * Case-folds one UTF-16 unit at a time and keeps any unit whose lowercase form
 * changes length, so an offset in the folded text is an offset in the DOM text.
 */
function fold(text: string): string {
  let folded = "";
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charAt(index);
    const lower = unit.toLowerCase();
    folded += lower.length === 1 ? lower : unit;
  }
  return folded;
}

function isSkipped(node: Node, root: Node): boolean {
  let parent = node.parentElement;
  while (parent && parent !== root) {
    if (SKIPPED_TAGS.has(parent.tagName)) {
      return true;
    }
    parent = parent.parentElement;
  }
  return false;
}

/** The last text node starting at or before `position`. */
function locate(
  starts: readonly number[],
  nodes: readonly Text[],
  position: number,
  isEnd: boolean,
): { node: Text; offset: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= position) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  // An end that lands exactly on a node boundary belongs to the node before it.
  if (isEnd && low > 0 && starts[low] === position) {
    const previous = nodes[low - 1] as Text;
    return { node: previous, offset: previous.data.length };
  }
  const node = nodes[low] as Text;
  return { node, offset: Math.min(position - (starts[low] ?? 0), node.data.length) };
}

/** Every non-overlapping, case-insensitive occurrence of `query` under `root`. */
export function findTextRanges(root: Node, query: string): Range[] {
  const needle = fold(query);
  if (needle.length === 0) {
    return [];
  }

  const nodes: Text[] = [];
  const starts: number[] = [];
  let haystack = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (isSkipped(node, root)) {
      continue;
    }
    const text = node as Text;
    nodes.push(text);
    starts.push(haystack.length);
    haystack += fold(text.data);
  }
  if (nodes.length === 0) {
    return [];
  }

  const ranges: Range[] = [];
  for (
    let at = haystack.indexOf(needle);
    at >= 0;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    const start = locate(starts, nodes, at, false);
    const end = locate(starts, nodes, at + needle.length, true);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    ranges.push(range);
  }
  return ranges;
}

/**
 * Highlights every hit in the mounted transcript rows and marks the active one.
 * Rows outside the virtualizer's window are not in the DOM; they are painted as
 * they mount, which is why callers repaint on DOM changes.
 */
export function applyTranscriptHighlights(input: {
  query: string;
  active: ActiveTranscriptHit | null;
  root?: ParentNode;
}): TranscriptHighlightResult {
  if (!highlightApiAvailable()) {
    return { count: 0, activeRange: null };
  }

  const scope = input.root ?? document;
  const ranges: Range[] = [];
  let activeRange: Range | null = null;
  if (input.query.length > 0) {
    for (const row of scope.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
      const rowRanges = findTextRanges(row, input.query);
      ranges.push(...rowRanges);
      if (
        input.active &&
        rowRanges.length > 0 &&
        row.getAttribute("data-history-row-id") === input.active.itemId
      ) {
        // The model counts hits in its own flattened text; when rendering shows
        // fewer, the last rendered hit is the closest honest target.
        activeRange = rowRanges[Math.min(input.active.occurrence, rowRanges.length - 1)] ?? null;
      }
    }
  }

  ensureStyle();
  CSS.highlights.set(FIND_HIGHLIGHT, new Highlight(...ranges));
  if (activeRange) {
    const active = new Highlight(activeRange);
    active.priority = 1;
    CSS.highlights.set(FIND_ACTIVE_HIGHLIGHT, active);
  } else {
    CSS.highlights.delete(FIND_ACTIVE_HIGHLIGHT);
  }
  return { count: ranges.length, activeRange };
}

export function clearTranscriptHighlights(): void {
  if (!highlightApiAvailable()) {
    return;
  }
  CSS.highlights.delete(FIND_HIGHLIGHT);
  CSS.highlights.delete(FIND_ACTIVE_HIGHLIGHT);
}

function scrollableAncestor(node: Node): HTMLElement | null {
  let element = node.parentElement;
  while (element) {
    const overflow = getComputedStyle(element).overflowY;
    if (
      (overflow === "auto" || overflow === "scroll") &&
      element.scrollHeight > element.clientHeight
    ) {
      return element;
    }
    element = element.parentElement;
  }
  return null;
}

/**
 * Scrolls the hit into view when it is off screen. A long message can put the
 * hit far below the row top the transcript jumps to.
 */
export function revealRange(range: Range): boolean {
  const container = scrollableAncestor(range.startContainer);
  if (!container) {
    return false;
  }
  const hit = range.getBoundingClientRect();
  if (hit.width === 0 && hit.height === 0) {
    return false;
  }
  const box = container.getBoundingClientRect();
  if (hit.top >= box.top + REVEAL_MARGIN_PX && hit.bottom <= box.bottom - REVEAL_MARGIN_PX) {
    return false;
  }
  container.scrollTop += hit.top - box.top - box.height / 3;
  return true;
}

/**
 * Runs `callback` once the row has stopped moving. The transcript's own jump
 * keeps re-aligning a row for up to 24 frames; revealing the exact hit before it
 * finishes would be undone.
 */
export function afterRowSettles(itemId: string, callback: () => void): () => void {
  if (typeof window === "undefined") {
    callback();
    return () => undefined;
  }
  let frames = 0;
  let stableFrames = 0;
  let lastTop: number | null = null;
  let handle = 0;
  let cancelled = false;
  const selector = `${ROW_SELECTOR.slice(0, -1)}="${CSS.escape(itemId)}"]`;

  const tick = () => {
    if (cancelled) {
      return;
    }
    frames += 1;
    const row = document.querySelector<HTMLElement>(selector);
    const top = row ? row.getBoundingClientRect().top : null;
    stableFrames =
      top !== null && lastTop !== null && Math.abs(top - lastTop) < 1 ? stableFrames + 1 : 0;
    lastTop = top;
    if ((top !== null && stableFrames >= SETTLE_STABLE_FRAMES) || frames >= SETTLE_MAX_FRAMES) {
      callback();
      return;
    }
    handle = window.requestAnimationFrame(tick);
  };
  handle = window.requestAnimationFrame(tick);

  return () => {
    cancelled = true;
    window.cancelAnimationFrame(handle);
  };
}
