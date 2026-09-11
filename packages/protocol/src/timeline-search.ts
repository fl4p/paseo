/**
 * Text rules shared by the daemon's timeline search and the app's transcript
 * Find, so a hit the daemon counts is a hit the app can show.
 */

/** Above this a count stops being useful and a scan stops being cheap. */
export const TIMELINE_SEARCH_MATCH_LIMIT = 5000;

/**
 * Message bodies are rendered as Markdown, so the reader sees `hello world`
 * where the source says `hello **world**`. Searching the source would miss the
 * phrase they are looking at, so inline markers are flattened first. This is
 * deliberately not a Markdown parser: it removes the inline syntax that splits
 * a visible phrase and leaves everything else alone. It avoids lookbehind so
 * every JavaScript engine the app ships on can parse it.
 */
export function flattenInlineMarkdown(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    .replace(/(\*\*\*|___)(.+?)\1/g, "$2")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])([*_])(?!\s)(.*?\S)\2(?![\w*])/g, "$1$3")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "");
}

interface SearchableTask {
  text?: unknown;
  status?: unknown;
  activeForm?: unknown;
}

/** A running task shows its active form in place of its text. */
function taskSearchText(task: SearchableTask): string {
  if (task.status === "in_progress" && typeof task.activeForm === "string") {
    return task.activeForm;
  }
  return typeof task.text === "string" ? task.text : "";
}

/**
 * The text a timeline item shows the reader. Rows whose body stays collapsed —
 * tool calls, plugin payloads — contribute nothing, because a hit the reader
 * cannot be taken to is worse than no hit. A tool call's label is not searched
 * here either: the app turns some tool calls into other rows, or drops them, by
 * provider, and a hit counted for a row the app never shows could not be found
 * again once its history loads.
 */
export function timelineItemSearchText(item: { readonly type: string }): string {
  const record = item as Record<string, unknown>;
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return typeof record.text === "string" ? flattenInlineMarkdown(record.text) : "";
    case "notification":
    case "error":
      return typeof record.message === "string" ? record.message : "";
    case "todo":
      return Array.isArray(record.items)
        ? (record.items as SearchableTask[]).map(taskSearchText).join("\n")
        : "";
    default:
      return "";
  }
}

/** Start offsets of non-overlapping, case-insensitive occurrences, at most `limit`. */
export function findTextOccurrences(text: string, query: string, limit: number): number[] {
  const needle = query.toLowerCase();
  if (needle.length === 0 || limit <= 0) {
    return [];
  }
  const haystack = text.toLowerCase();
  const starts: number[] = [];
  for (
    let at = haystack.indexOf(needle);
    at >= 0 && starts.length < limit;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    starts.push(at);
  }
  return starts;
}
