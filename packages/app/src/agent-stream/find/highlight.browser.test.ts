import { afterEach, describe, expect, it } from "vitest";
import {
  applyTranscriptHighlights,
  clearTranscriptHighlights,
  FIND_ACTIVE_HIGHLIGHT,
  FIND_HIGHLIGHT,
  findTextRanges,
} from "./highlight.web";

function mount(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  return container;
}

afterEach(() => {
  clearTranscriptHighlights();
  document.body.innerHTML = "";
});

describe("findTextRanges", () => {
  it("finds every non-overlapping, case-insensitive hit", () => {
    const root = mount("<p>Widget widget WIDGET</p>");

    expect(findTextRanges(root, "widget").map((range) => range.toString())).toEqual([
      "Widget",
      "widget",
      "WIDGET",
    ]);
    expect(findTextRanges(mount("<p>aaaa</p>"), "aa")).toHaveLength(2);
  });

  it("matches a phrase that markup splits across elements", () => {
    const root = mount("<p>hello <strong>world</strong>, again</p>");

    const ranges = findTextRanges(root, "hello world");

    expect(ranges).toHaveLength(1);
    expect(ranges[0]?.toString()).toBe("hello world");
  });

  it("ignores script and style text", () => {
    const root = mount("<p>needle</p><script>var needle = 1;</script><style>.needle{}</style>");

    expect(findTextRanges(root, "needle")).toHaveLength(1);
  });

  it("finds nothing for an empty query or an empty subtree", () => {
    expect(findTextRanges(mount("<p>needle</p>"), "")).toEqual([]);
    expect(findTextRanges(mount("<div></div>"), "needle")).toEqual([]);
  });
});

describe("applyTranscriptHighlights", () => {
  it("only paints inside transcript rows, never the find field or other chrome", () => {
    mount(
      '<input value="needle" /><div>needle in the sidebar</div>' +
        '<div data-history-row-id="a">a needle in the transcript</div>',
    );

    const result = applyTranscriptHighlights({ query: "needle", active: null });

    expect(result.count).toBe(1);
    expect(CSS.highlights.get(FIND_HIGHLIGHT)?.size).toBe(1);
    expect(CSS.highlights.has(FIND_ACTIVE_HIGHLIGHT)).toBe(false);
  });

  it("marks the requested occurrence in the requested row as active", () => {
    mount(
      '<div data-history-row-id="a">needle</div>' +
        '<div data-history-row-id="b">first needle, then the second needle</div>',
    );

    const { count, activeRange } = applyTranscriptHighlights({
      query: "needle",
      active: { itemId: "b", occurrence: 1 },
    });

    expect(count).toBe(3);
    expect(activeRange?.toString()).toBe("needle");
    // The second hit in row b, not the first.
    expect(activeRange?.startOffset).toBe("first needle, then the second ".length);
    expect(CSS.highlights.get(FIND_ACTIVE_HIGHLIGHT)?.size).toBe(1);
  });

  it("falls back to the last rendered hit when the model counted more", () => {
    mount('<div data-history-row-id="a">one needle, two needle</div>');

    const { activeRange } = applyTranscriptHighlights({
      query: "needle",
      active: { itemId: "a", occurrence: 5 },
    });

    expect(activeRange?.startOffset).toBe("one needle, two ".length);
  });

  it("clears both highlights", () => {
    mount('<div data-history-row-id="a">needle</div>');
    applyTranscriptHighlights({ query: "needle", active: { itemId: "a", occurrence: 0 } });

    clearTranscriptHighlights();

    expect(CSS.highlights.has(FIND_HIGHLIGHT)).toBe(false);
    expect(CSS.highlights.has(FIND_ACTIVE_HIGHLIGHT)).toBe(false);
  });
});
