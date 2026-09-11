# Pi: queue user turns without misattributing the streaming turn

Status: open. Motivating symptom: a user message sent while pi is still streaming
surfaces as `[System Error] Agent is already processing. Specify streamingBehavior
('steer' or 'followUp') to queue the message.`

## Why `startTurn` cannot simply pass `streamingBehavior: "followUp"`

That was tried in 96db18f and reverted. In
`packages/server/src/server/agent/providers/pi/agent.ts`:

1. `startTurn` claims `activeTurnId` synchronously, before the prompt is sent, and
   resets `activeTurnStarted`, `activeTurnStartedEmitted` and
   `pendingSteerSubmissions`.
2. `currentTurnIdForEvent()` is just `activeTurnId`; nothing ties an event to the pi
   turn that produced it.
3. With `followUp`, pi acknowledges queue _admission_ while the previous turn is still
   streaming. Its remaining text and tool events are stamped with the new turn's id,
   its next `turn_start` becomes the new turn's start, and the new turn's real start
   is then swallowed by the `activeTurnStartedEmitted` guard.

Without `followUp`, pi rejects the prompt and the `catch` in `startTurn` releases the
turn and emits `turn_failed` within one RPC round-trip: loud, but attributed correctly.
`agent.test.ts` ("never queues a user turn behind a turn Pi is still streaming")
guards this.

`"steer"` does not help: the missing piece is ownership, not queue semantics.

## What a real fix needs

- Separate a **pending** turn (admitted, queued in pi) from the **executing** turn
  (owner of incoming events). `currentTurnIdForEvent()` returns the executing one.
- Promote pending to executing on the pi `turn_start` that belongs to it, not on
  prompt acknowledgement. Model this on the steer path, which keeps the existing turn
  and records submitted-message identities separately.
- Rework `completeNoTurnPrompt` and `completePromptIfHandledWithoutTurn`, which assume
  the admitted turn is the active one.
- Define pending-turn outcomes for `clear_queue` and `interrupt()`: a cleared queue
  must cancel the pending turn rather than leave it waiting for a `turn_start` that
  never arrives.

Also worth finding: what lets Paseo believe no turn is active while pi is still
streaming. That desync is the actual trigger for the error.

## Not affected

The tree-navigation and entry-capture extension commands keep `"followUp"`. pi runs a
registered extension command before its streaming check
(`coding-agent/src/core/agent-session.ts`, "execute immediately, even during
streaming"), so the flag only matters if the command falls through to a normal prompt.
