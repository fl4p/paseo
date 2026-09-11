import type { CompactionItem, StreamItem, UserMessageItem } from "@/types/stream";
import type { TurnLiveness } from "@/timeline/turn-liveness";

/**
 * Whether a prompt is a manual `/compact` (with or without instructions). Mirrors the providers'
 * `parseSlashCommandInput` (Claude, Codex, pi, OMP); pi and OMP lower-case the name, so this does.
 */
export function isCompactCommandText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || trimmed.length <= 1) return false;
  const withoutPrefix = trimmed.slice(1);
  const firstWhitespaceIdx = withoutPrefix.search(/\s/);
  const commandName =
    firstWhitespaceIdx === -1 ? withoutPrefix : withoutPrefix.slice(0, firstWhitespaceIdx);
  return commandName.toLowerCase() === "compact";
}

/**
 * A slash command that runs beside the conversation without being a prompt (e.g. `/autocompact`,
 * `/goal pause` on an out-of-band provider). It can land while a compaction runs, so it says
 * nothing about whether that compaction has ended.
 */
function isSideCommandRow(item: UserMessageItem): boolean {
  return item.turnId === undefined && item.text.trim().startsWith("/");
}

/** The newest item that decides compaction progress, and whether anything landed after it. */
interface CompactionEvidence {
  item: CompactionItem | UserMessageItem;
  sawLaterItem: boolean;
}

function findCompactionEvidence(items: readonly StreamItem[]): CompactionEvidence | null {
  let sawLaterItem = false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) continue;
    if (item.kind === "compaction") return { item, sawLaterItem };
    if (
      item.kind === "user_message" &&
      (isCompactCommandText(item.text) || !isSideCommandRow(item))
    ) {
      return { item, sawLaterItem };
    }
    sawLaterItem = true;
  }
  return null;
}

// Tails are replaced, never mutated, so a tail's evidence is fixed for its lifetime. Streaming
// commits re-evaluate on every frame; without this each one rescans the whole current turn.
const tailEvidenceCache = new WeakMap<readonly StreamItem[], CompactionEvidence | null>();

function findTailCompactionEvidence(tail: readonly StreamItem[]): CompactionEvidence | null {
  if (tailEvidenceCache.has(tail)) return tailEvidenceCache.get(tail) ?? null;
  const evidence = findCompactionEvidence(tail);
  tailEvidenceCache.set(tail, evidence);
  return evidence;
}

function isLoadingMarkerLive(marker: CompactionItem, turn: TurnLiveness): boolean {
  if (marker.status !== "loading") return false;
  // No turn: an out-of-band compaction (Codex, pi, OMP). Only its terminal marker ends it.
  if (marker.turnId === undefined) return true;
  // A turn-bound marker cannot outlive its turn: the turn's end terminalizes it. A tail that
  // stopped receiving live events can still hold it open, and must not stall the queue.
  // COMPAT(agentTurnIdentity): an open turn without an id may be the marker's turn.
  return turn.phase === "open" && (turn.turnId === null || turn.turnId === marker.turnId);
}

function isEvidenceInProgress(evidence: CompactionEvidence | null, turn: TurnLiveness): boolean {
  if (!evidence) return false;
  const { item } = evidence;
  if (item.kind === "compaction") return isLoadingMarkerLive(item, turn);
  // The window between dispatching `/compact` and the provider's first marker: the `/compact` row
  // itself (optimistic while sending, canonical once acknowledged) is the newest thing in the
  // timeline. Anything after it (a marker, or an error for a compaction that never started) is
  // the provider's answer. A row that belongs to a turn is covered by that turn's liveness.
  return !evidence.sawLaterItem && isCompactCommandText(item.text) && item.turnId === undefined;
}

/**
 * Whether the agent is compacting, as far as its timeline shows: an open `loading` marker, or a
 * `/compact` that has been dispatched and not yet answered. A newer prompt row ends any older
 * compaction: the daemon only admits a prompt once the compaction it held for has ended.
 */
export function resolveCompactionInProgress(input: {
  tail: readonly StreamItem[];
  head: readonly StreamItem[];
  turn: TurnLiveness;
}): boolean {
  const headEvidence = findCompactionEvidence(input.head);
  if (headEvidence) return isEvidenceInProgress(headEvidence, input.turn);
  const tailEvidence = findTailCompactionEvidence(input.tail);
  if (!tailEvidence) return false;
  return isEvidenceInProgress(
    input.head.length > 0 ? { ...tailEvidence, sawLaterItem: true } : tailEvidence,
    input.turn,
  );
}
