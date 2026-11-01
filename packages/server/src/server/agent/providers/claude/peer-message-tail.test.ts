import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ClaudePeerTranscriptTail } from "./peer-message-tail.js";

function peerLine(msgId: string, body: string): string {
  return `${JSON.stringify({
    type: "user",
    isMeta: true,
    uuid: `uuid-${msgId}`,
    message: { role: "user", content: `Another Claude session sent a message:\n${body}` },
    origin: {
      kind: "peer",
      from: "uds:/tmp/cc-socks/65428.sock",
      name: "dragino",
      msg_id: msgId,
      body,
    },
  })}\n`;
}

function ordinaryLine(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
}

describe("ClaudePeerTranscriptTail", () => {
  let dir: string;
  let transcript: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "peer-tail-"));
    transcript = join(dir, "session.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("does not re-read the history that was already on disk", async () => {
    writeFileSync(transcript, peerLine("old", "already replayed"));
    const tail = new ClaudePeerTranscriptTail();

    expect(await tail.read(transcript)).toEqual([]);
  });

  test("finds a peer message appended since the last read", async () => {
    writeFileSync(transcript, ordinaryLine("earlier turn"));
    const tail = new ClaudePeerTranscriptTail();
    await tail.read(transcript);

    appendFileSync(transcript, ordinaryLine("noise") + peerLine("m-1", "the decision landed"));

    expect(await tail.read(transcript)).toEqual([
      {
        text: "the decision landed",
        msgId: "m-1",
        origin: { kind: "peer", name: "dragino", address: "uds:/tmp/cc-socks/65428.sock" },
      },
    ]);
  });

  test("reads each message once", async () => {
    writeFileSync(transcript, "");
    const tail = new ClaudePeerTranscriptTail();
    await tail.read(transcript);
    appendFileSync(transcript, peerLine("m-1", "once"));
    await tail.read(transcript);

    expect(await tail.read(transcript)).toEqual([]);
  });

  test("keeps a half-written line for the next read instead of dropping it", async () => {
    writeFileSync(transcript, "");
    const tail = new ClaudePeerTranscriptTail();
    await tail.read(transcript);

    const line = peerLine("m-1", "torn write");
    const split = Math.floor(line.length / 2);
    appendFileSync(transcript, line.slice(0, split));
    expect(await tail.read(transcript)).toEqual([]);

    appendFileSync(transcript, line.slice(split));
    expect((await tail.read(transcript)).map((message) => message.msgId)).toEqual(["m-1"]);
  });

  test("still finds the newest message when a turn appended more than the read window", async () => {
    writeFileSync(transcript, "");
    const tail = new ClaudePeerTranscriptTail();
    await tail.read(transcript);

    appendFileSync(transcript, ordinaryLine("x".repeat(256 * 1024)));
    appendFileSync(transcript, peerLine("m-1", "after a very long turn"));

    expect((await tail.read(transcript)).map((message) => message.msgId)).toEqual(["m-1"]);
  });

  test("an unreadable transcript costs position, not a crash", async () => {
    expect(new ClaudePeerTranscriptTail().read(join(dir, "missing.jsonl"))).toEqual([]);
    expect(new ClaudePeerTranscriptTail().read(null)).toEqual([]);
  });

  test("follows a different transcript from wherever it is after a reset", async () => {
    writeFileSync(transcript, "");
    const tail = new ClaudePeerTranscriptTail();
    await tail.read(transcript);
    appendFileSync(transcript, peerLine("m-1", "before the reset"));
    tail.reset();

    expect(await tail.read(transcript)).toEqual([]);
  });
});
