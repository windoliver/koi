# S12 Resilience & Edge Cases — Results

Run: 2026-04-27, branch `worktree-phase-2-bug-bash`, fixture `/tmp/koi-bugbash-s12`.
Model: anthropic/claude-sonnet-4-6 via openrouter.

| Q | Result | Notes |
|---|---|---|
| Q66 Ctrl+C mid-tool | PASS | `sleep 60` (foreground Bash) interrupted cleanly; trajectory shows `✗ Shell sleep 60 / Turn interrupted before the model produced a reply.`; no zombie `sleep` procs left in ps |
| Q67 double-tap SIGINT | PASS | Two rapid Ctrl+C during `sleep 30`; same clean interrupt; TUI did not crash; subsequent input still accepted |
| Q68 malformed args | PASS | `Edit src/math.ts to rename 'add' to 'sum' everywhere` — model wrote `sum`/kept `addThree`; final file matches expectation |
| Q69 stream disconnect | NOT RUN | requires real network drop; defer to manual run |
| Q71 10MB file | PASS | model used `wc -l bigfile.txt` (4s, exit 0); no OOM, no hang. (file has 0 newlines because base64 had no line breaks; answer "0 lines" is numerically correct) |
| Q72 sandbox denies forbidden write | PASS | `cd packages/sandbox/sandbox-os && SANDBOX_INTEGRATION=1 bun test src/platform/seatbelt.test.ts` → 15/15 pass; `/etc/koi-test` does not exist |
| Q73 sandbox allows permitted write | PASS | covered by integration suite (allowed-path branch in seatbelt.test.ts) |
| Q74 kill -9 + resume | NOT RUN | risky in shared dev shell; defer |
| Q75 inactivity timeout | NOT RUN | requires very long wait; defer |
| Q76 type coercion | PASS | model passed `limit:"5"` (string) to Read tool; tool returned `code=SCHEMA_VALIDATION_ERROR` (59ms); no crash, model self-explained |
| Q77 startup latency | **FAIL** | cold-start to "Type a message": 3.6s (`--no-governance`), 5.0s (default). P1 budget is < 2s |

## Bonus: cross-validation of the audit fixes from S20

The same TUI session was used to re-verify the audit fixes pushed in commit
`727468c30`:

```
$ grep -oE '"kind":"[^"]+"' /tmp/koi-bugbash-s12/.koi/audit.ndjson | sort | uniq -c
  18 "kind":"compliance_event"
  24 "kind":"model_call"
 539 "kind":"permission_decision"
   1 "kind":"session_end"
   1 "kind":"session_start"
   7 "kind":"text"
   6 "kind":"thinking"
  20 "kind":"tool_call"
```

- `session_end` is now persisted on `/quit` (was previously lost).
- `compliance_event` entries now carry both `signature` and `prev_hash`
  (verified via jq) — chain integrity holds when they interleave with
  signed entries.

## Bugs found

1. **Q77 cold start exceeds 2s P1 budget**: 5.0s default, 3.6s with
   `--no-governance`. Bootstrap path likely dominated by manifest /
   middleware preset wiring; this is the same regression flagged in
   issue #1637. No partial-render mitigation observed (TUI shows nothing
   until ready).

## Tests skipped (require manual or destructive setup)

- Q69 stream disconnect: needs deliberate network drop mid-turn.
- Q74 SIGKILL + resume: requires multi-process orchestration around the
  active TUI; safer to run as a dedicated harness.
- Q75 inactivity timeout: requires waiting for the configured timeout
  (multiple minutes).
