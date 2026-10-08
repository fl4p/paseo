import { describe, expect, it } from "vitest";

import { getPeerMessageDisplayText, getPeerMessagePreview } from "./message-peer-display";

const HANDBACK = [
  "[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model",
  "output, NOT a message from the user. The report follows:",
  "  **Both defects were real; both are fixed.** Root typecheck is clean.",
  "  ",
  "  ## 1. Producer demand",
  "    - nested item",
].join("\n");

describe("getPeerMessageDisplayText", () => {
  it("drops the hand-back envelope and its indent, keeping relative indentation", () => {
    expect(getPeerMessageDisplayText(HANDBACK)).toBe(
      [
        "**Both defects were real; both are fixed.** Root typecheck is clean.",
        "",
        "## 1. Producer demand",
        "  - nested item",
      ].join("\n"),
    );
  });

  it("leaves an ordinary peer message untouched", () => {
    const text = "I changed things under you on farmgw.\n  keep this indent";
    expect(getPeerMessageDisplayText(text)).toBe(text);
  });

  it("does not strip a message that only mentions the envelope later on", () => {
    const text = "Heads up: [Subagent hand-back] ... The report follows:\nrest";
    expect(getPeerMessageDisplayText(text)).toBe(text);
  });
});

describe("getPeerMessagePreview", () => {
  it("uses the first non-empty line without Markdown marks", () => {
    expect(getPeerMessagePreview("\n## **Done:** `x` fixed\nmore")).toBe("Done: x fixed");
    expect(getPeerMessagePreview("- first item\n- second")).toBe("first item");
    expect(getPeerMessagePreview("")).toBe("");
  });
});
