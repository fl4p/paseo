/**
 * Claude Code wraps a subagent's report in a fixed preamble and indents every line of the
 * report, so a forged frame inside it stands out to the model. That envelope is for the model;
 * the reader wants the report.
 */
const SUBAGENT_HANDBACK_PREAMBLE = /^\[Subagent hand-back\][\s\S]*?The report follows:[^\S\n]*\n/;

/** The peer message as the reader should see it: no hand-back envelope, no envelope indent. */
export function getPeerMessageDisplayText(text: string): string {
  const match = SUBAGENT_HANDBACK_PREAMBLE.exec(text);
  if (!match) return text;
  return dedent(text.slice(match[0].length)).trim();
}

/** One line that stands for the collapsed message: its first non-empty line, minus Markdown marks. */
export function getPeerMessagePreview(displayText: string): string {
  const firstLine = displayText.split("\n").find((line) => line.trim().length > 0) ?? "";
  return firstLine
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*)/, "")
    .replace(/\*\*|__|`/g, "")
    .trim();
}

function dedent(text: string): string {
  const lines = text.split("\n");
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.length - line.trimStart().length);
  const common = indents.length > 0 ? Math.min(...indents) : 0;
  return common === 0 ? text : lines.map((line) => line.slice(common)).join("\n");
}
