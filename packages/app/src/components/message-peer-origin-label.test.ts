import { describe, expect, it } from "vitest";

import { i18n } from "@/i18n/i18next";
import { getPeerMessageOriginLabel } from "./message-peer-origin-label";

describe("getPeerMessageOriginLabel", () => {
  it("prefers the reported name, falls back to the address, then to the unnamed sender", () => {
    expect(
      getPeerMessageOriginLabel({
        kind: "peer",
        name: "dragino",
        address: "uds:/tmp/cc-socks/65428.sock",
      }),
    ).toBe("From dragino");
    expect(
      getPeerMessageOriginLabel({ kind: "peer", address: "uds:/tmp/cc-socks/65428.sock" }),
    ).toBe("From uds:/tmp/cc-socks/65428.sock");
    expect(getPeerMessageOriginLabel({ kind: "peer" })).toBe("From another session");
  });

  it("renders labels in the active app language", async () => {
    await i18n.changeLanguage("zh-CN");
    try {
      expect(getPeerMessageOriginLabel({ kind: "peer", name: "dragino" })).toBe("来自 dragino");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
