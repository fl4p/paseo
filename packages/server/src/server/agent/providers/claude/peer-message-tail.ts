import fs from "node:fs";

import { type ClaudePeerMessage, readClaudePeerMessage } from "./peer-message.js";

/**
 * The transcript has a peer's message before the turn it started produces anything; the live
 * stream does not have it until that turn ends. Reading the transcript's tail when a turn starts
 * is what puts the message above the reply it caused instead of below it.
 *
 * This is position only, never delivery: the `result` frame remains the guarantee, and the shared
 * delivery id makes a message this finds and a message the result frame carries the same item. So
 * a tail read that finds nothing, races a half-written line, or hits an unreadable file costs the
 * message its place and nothing else — every failure here degrades to the old behaviour.
 *
 * Reading starts from where the transcript was at the first turn, not from the beginning: entries
 * older than that belong to replayed history, which has its own path to the timeline.
 */
export class ClaudePeerTranscriptTail {
  /** Bytes read per turn are bounded; a peer's entry is the newest line, so the tail is enough. */
  private static readonly maxBytes = 128 * 1024;

  private offset: number | null = null;

  /** Follow a different transcript from wherever it currently is (resume, fork, rewind). */
  reset(): void {
    this.offset = null;
  }

  read(historyPath: string | null): ClaudePeerMessage[] {
    if (!historyPath) {
      return [];
    }
    let size: number;
    try {
      size = fs.statSync(historyPath).size;
    } catch {
      return [];
    }
    const previous = this.offset;
    if (previous === null || size <= previous) {
      this.offset = size;
      return [];
    }

    const from = Math.max(previous, size - ClaudePeerTranscriptTail.maxBytes);
    let chunk: string;
    try {
      chunk = readRange(historyPath, from, size);
    } catch {
      this.offset = size;
      return [];
    }

    // A line still being written is not skipped, it is left for the next read: the offset stops
    // at the last newline, so the entry is picked up whole next turn rather than lost as garbage.
    const lastNewline = chunk.lastIndexOf("\n");
    this.offset = lastNewline === -1 ? previous : from + lastNewline + 1;

    const messages: ClaudePeerMessage[] = [];
    for (const line of chunk.slice(0, Math.max(lastNewline, 0)).split("\n")) {
      const peerMessage = readPeerMessageLine(line);
      if (peerMessage) {
        messages.push(peerMessage);
      }
    }
    return messages;
  }
}

/** Only the requested window is read; the transcript itself grows without bound. */
function readRange(historyPath: string, from: number, to: number): string {
  const buffer = Buffer.alloc(to - from);
  const fd = fs.openSync(historyPath, "r");
  try {
    const read = fs.readSync(fd, buffer, 0, buffer.length, from);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function readPeerMessageLine(line: string): ClaudePeerMessage | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    return readClaudePeerMessage(JSON.parse(trimmed));
  } catch {
    return null;
  }
}
