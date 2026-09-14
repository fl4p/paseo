# Claude subscription account review

Candidate: `feat/claude-subscription-accounts`, based on `071ffb064`.
Setup: [Claude Code guide](../public-docs/claude-code.md#multiple-subscription-accounts).

## Guard review

1. **Unevaluable input:** Unknown account IDs, invalid paths, missing/empty/malformed transcripts, SDK cleanup errors, and uncertain process exit reject the switch. The selected account and native handle stay unchanged.
2. **Monotonicity:** Additional transcript entries cannot hide a malformed final entry. Synthetic 1,000- and 100,000-entry transcripts with a broken final line both reject. Unknown or paused task statuses do not clear an unsettled task. Both process timeout and termination exceptions prevent switching and replacement launches.
3. **Preconditions:** Registry tests exercise configured accounts through the real provider factory. A real child process confirms environment overrides survive the SDK spawn callback. Foreground start and concurrent switch races reject. The original process is retired before transcript reading.
4. **Source of truth:** The native JSONL transcript is copied directly; conversation message IDs and compaction links are preserved. Native SDK fork operations use the selected account's filesystem store. No display transcript or cached usage report substitutes for native history.
5. **Persistence:** Account choice and the replacement native handle are saved together before another turn. The manager regression first failed with the old handle, then passed with immediate refresh. Failed copies retain the source; cleanup removes only paths created by that copy. No verification cache is introduced.
6. **Provenance:** Server tests use synthetic histories and injected SDK queries; the environment test spawns Node. Browser tests use a real isolated daemon and empty account directories. Two signed-in subscription accounts and native iOS/Android devices have not been exercised. Existing usage reporting still refers to the default account.
7. **Known-bad calibration:** Tests construct unknown accounts, missing and malformed history, inherited credential variables, an active foreground launch, simultaneous switch requests, unsettled background tasks, process exit timeouts, and termination exceptions. They observe rejection or credential removal at the corresponding boundary.
8. **Fix vs mute:** Switching changes the actual subprocess configuration and copied native conversation; pending/error UI reflects the real RPC result. It does not merely relabel an account or hide an authentication error.

## Validation

- 72 tests passed in the five changed Claude test files; the focused manager persistence regression also passed.
- The same browser flow passed at 1440 × 1000 and 430 × 932: initial account selection, switch, reload, rejected switch, pending controls, and account selection in a replacement new-session draft.
- Workspace typechecking and lint passed. Server, CLI, and bundled daemon web UI builds passed.
- The main daemon was not restarted, and real account configuration was not edited.

## Runtime measurement

On 2026-09-14, macOS arm64 with the arm64 Node executable, one synthetic local copy took 8 ms for 1,000 entries / 127,890 bytes and 153 ms for 100,000 entries / 12,988,890 bytes. Appending malformed JSON to those inputs rejected in 1 ms and 112 ms. These are single-run observations on the development machine, not latency guarantees. The process-close budget is up to 3 seconds for the SDK iterator plus two 2-second process-exit waits.

Measured source SHA-256 (`packages/server/src/server/agent/providers/claude/accounts.ts`):
`a3e777397ca70b1ccab2683a99297fa5115c6e4bc9afacb97d8cd0f4a73fb35c`.

Input-generator script SHA-256 (`/private/tmp/paseo-account-copy-bench.mts`):
`88a902abe5eaaae85e0f4d0d2b219d34cb8e0aba6ac96188d44d79cd202730be`.
The script generates JSONL user messages with UUIDs `entry-N`, session ID `source`, and content `synthetic conversation checkpoint`, then appends a broken final JSON object for the rejection case.
