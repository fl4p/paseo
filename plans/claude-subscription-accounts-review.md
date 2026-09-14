# Claude subscription account review

Candidate: `feat/claude-subscription-accounts`; subagent migration follows `0be7ba19b`.
Setup: [Claude Code guide](../public-docs/claude-code.md#multiple-subscription-accounts).

## Guard review

1. **Unevaluable input:** Unknown accounts, missing/empty/malformed child transcripts, missing native resume metadata, explicitly stopped agents, and untracked sidechains reject migration before stopping work. Failed process census, unavailable launch identity, or surviving owned descendants forbid a replacement process. Cleanup retains its ownership snapshot for retry; Windows refuses live-subagent migration before shutdown. A confirmed exit followed by SDK cleanup failure requests recovery on the original account and reports the error.
2. **Monotonicity:** Every active task must be classifiable as a saved native agent. Adding a shell, workflow, unknown task, or unmapped sidechain never enables migration. A broken last line in the last of ten large transcripts rejects validation. Unknown task statuses remain unsettled. Root exit does not clear surviving descendants; TERM-ignoring descendants still receive SIGKILL.
3. **Preconditions:** Tests drive the public session feature setter, native task events, real filesystem sidecars, and SDK input queues. A real child process exercises successful termination with a rejected SDK return. Preflight is rechecked before shutdown; task announcements arriving during shutdown are drained and reconciled before runtime statuses are cleared.
4. **Source of truth:** Native JSONL and `.meta.json` sidecars retain agent identities and context. The recovery turn addresses existing IDs with `SendMessage`. The root coordinates all listed agents, including descendants; recipients are explicitly told not to recover descendants again. No display transcript or cached usage report substitutes for native history. Process ownership uses launch-time birth identity, a refresh before SDK shutdown, and an owned POSIX process group; a different group leader is not adopted.
5. **Persistence:** Account choice and native handle remain paired. Copy failures retain the original account and request recovery there. Recovery is a visible conversation turn, so quota errors and native refusals remain visible. Pending recovery IDs persist across quota failures, account switches, and reloads until native acknowledgement, explicit stop, or a fresh conversation. Saved histories remain available for retry. There is no automatic retry loop or verification cache.
6. **Provenance:** Deterministic tests verify different account directories and launch environments. A live Claude probe verified copying to a fresh session UUID and resuming the same native agent ID; the child returned its remembered secret. A live public `ClaudeAgentClient.setFeature` probe resumed the same provider-subagent ID and wrote its remembered secret to a scratch file. Both successful live probes used Supercacha authentication. Malte hit its session limit and the explicitly selected default config hit its weekly limit, so successful inference across two distinct subscription identities remains unverified. Native iOS/Android devices and Windows process cleanup were not exercised. Late processes that independently detach before any ownership census are outside the inherited-group regression.
7. **Known-bad calibration:** Real process regressions cover already-exited roots, TERM-ignoring descendants, late inherited children, and a reused group-leader identity left alive. An adapter regression covers quota failure, reload, another account switch, and native recovery acknowledgement. Other regression cases include SDK return rejection after process termination, a hung old query pump followed by a stale result, late child/shell announcements, a last child completing while a late shell remains, malformed history, explicit stop markers, and an unwritable target. A separate native probe confirmed that `stopTask` persists `stoppedByUser` and prevents resuming that agent; migration intentionally retires the process without that marker.
8. **Fix vs mute:** Switching retires the old runtime, copies native history where needed, selects the launch environment, and submits recovery using the existing agent IDs. Old query event delivery is invalidated before replacement launch, including on drain timeout. Shells or workflows created during shutdown are explicitly reported as interrupted and never automatically replayed. Recovery is requested, not claimed complete merely because the account setter succeeded.

## Validation

- Initial migration candidate: 15 migration tests and 70 affected account, process-launch, and task-protocol regressions passed.
- Review fixes: 23 tests passed across the changed migration, process-launch, and process-tree files; the Windows-only rejection case was skipped on macOS.
- Workspace typecheck and lint passed.
- Independent review of the pushed candidate found orphaned descendants and lost recovery IDs after quota failure. Follow-up inspection covered cleanup retries, process ownership, PID reuse, and recovery lifecycle. The final read-only review reported no remaining concrete blockers.
- The existing account-selection UI is reused. Earlier desktop and compact browser tests covered initial selection, switching, reload persistence, pending controls, and visible errors.
- Packaged build, isolated desktop smoke test, and deployment verification for the preceding `fe5d4e8be` deployment are recorded under `.dev/account-migration/`. The current review fixes have not been redeployed.

## Runtime measurement

On 2026-09-14, macOS arm64, two validation passes over ten subagents took 32 ms for 1,000 entries / 113,890 bytes per child and 2,068 ms for 100,000 entries / 11,588,890 bytes per child. A broken final line in the last child rejected in 12 ms and 1,147 ms respectively. These are single local synthetic measurements, not latency guarantees. They exclude copying and Claude's recovery model calls. Shutdown allows up to 3 seconds for SDK return, two 2-second termination phases, and 3 seconds to drain the old event pump. Each process census has its own 5-second timeout, so these phase limits are not a strict wall-clock bound.

The new process guard was measured separately on ten real, isolated Node process groups: mean launch capture 31.64 ms, pre-close refresh 30.96 ms, graceful cleanup 85.90 ms. The input is one idle Node child per sample; this excludes model calls and does not predict large-tree cleanup latency. Results: `.dev/account-migration/process-benchmark.json`.

Process benchmark SHA-256:

- `utils/process-tree.ts`: `e3d500969832263162733e146f160ee98779a1b90ea336d042ffaa4a27ad9b73`
- Input `.dev/account-migration/process-benchmark.mts`: `99e16f6a3a2a443bc739b39fbabc99bc93957ad216b7c80f1d988e22a4d698d4`

Original transcript-validation measurement source SHA-256 (before these review fixes):

- `accounts.ts`: `4b5c83ecb5c0b89851d33bb12b1d81962f6446c989480841e3ec1ffa6d4d8aca`
- `agent.ts`: `cb51874ba64163b8c67a547e26d2bc2ea359b6bc483654cc47b9b4168c35ee58`
- `subagents/live-source.ts`: `5d8cb56ec9d7793478f3f7beca5e27dc410e6e78a6aacd409f9059703df6cab0`
- Input generator `.dev/account-migration/benchmark.mts`: `5b37e71277245c87f56437c3a5dbd174245e043002174b521b573b21a53836b9`

The generator creates ten native sidecars containing JSONL user messages with UUID `entry-N`, session ID `session`, and content `synthetic saved subagent context`, plus native metadata; the rejection case appends malformed JSON to child 9.
