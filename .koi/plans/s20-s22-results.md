# S20 / S21 / S22 — Results (T9)

Run: 2026-04-27. Captures: `/tmp/koi-phase-2-bug-bash-t9-results/`.

## S20 — Audit Stack

| Q | Result | Notes |
|---|---|---|
| Q126 fs_read | PASS | tool_call + permission_decision + model_call entries written |
| Q127 Bash audit | PASS | tool_call entry contains command + stdout/stderr |
| Q128 session_start/end | **FAIL → FIXED (727468c30)** | only `session_start` written; `session_end` never reached disk on /quit. Fix: moved audit-sink close into a manifest-middleware shutdown hook so it runs AFTER `runtime.dispose()` fires `audit.onSessionEnd`, plus added a synchronous `appendFileSync` + `fsync` `logSync` path on the NDJSON sink that `audit.onSessionEnd` uses to guarantee the closing record reaches disk even when the async write chain has wedged. |
| Q129 hash chain | PASS w/ caveat | NDJSON entries have `prev_hash` populated; chain links via canonical_json |
| Q130 secret redaction | PASS | "sk-secret123" never appears in audit (exfiltration guard blocks first) |
| Q131 NDJSON valid | PASS | 238 lines, all parse, all have kind/timestamp/sessionId |
| Q132 sqlite kinds | PASS | counts match NDJSON exactly; spec uses outdated table name `audit_entries` (real table: `audit_log`) |
| Q133 signatures | **FAIL → FIXED (727468c30)** | 7 × `compliance_event` rows had empty `signature` AND empty `prev_hash` — chain integrity broken when these interleaved with signed entries. Fix: `createAuditMiddlewareComplianceRecorder` now routes governance compliance events through the audit middleware's `append()` so they share the same chained signing pipeline as `model_call`/`tool_call`/`session_*`. |

### S20 Bugs

1. **`session_end` missing on /quit** — *FIXED in 727468c30*. Root cause: `shutdownBackgroundTasks` closed the audit sink before `runtime.dispose()` fired `audit.onSessionEnd`, so the closing record's async write silently no-op'd against the already-set `closedFlag`. Fix moves sink close into a manifest-middleware shutdown hook (runs AFTER engine dispose) and adds a synchronous `appendFileSync` + `fsync` `logSync` path on the NDJSON sink that `audit.onSessionEnd` uses to guarantee the closing record reaches disk even when the async write chain has wedged.
2. **`compliance_event` entries unsigned + no prev_hash** — *FIXED in 727468c30*. Root cause: `governance-core`'s compliance recorder called `sink.log()` directly, bypassing the audit middleware's hash-chain + signing pipeline. Fix: `createAuditMiddlewareComplianceRecorder` (new factory exported from `@koi/middleware-audit`) routes compliance events through the middleware's `append()` so every record on the shared audit stream — including `compliance_event` — participates in the same `prev_hash` and Ed25519 signing scheme.
3. **`model_call.request` stored as JSON string** — inconsistent with `tool_call.request` which is a structured object. Same for `permission_decision.request.principal` (string instead of array). *Open — schema cleanup, not a forensic-trust bug.*
4. **Excessive `permission_decision`**: 223 entries for 8 turns. Every model call emits one decision per *available* tool (the filter) instead of per *invoked* tool. May be by design, but is noisy. *Open — pending product decision.*

## S21 — Task Planning & Run Report

| Q | Result | Notes |
|---|---|---|
| Q134 task_create | PASS | task board with 4 tasks; model decomposed correctly |
| Q135 task_update | PASS | task_update steps visible in trajectory; statuses transitioned to completed |
| Q136 idle anchor | PASS w/ caveat | task-anchor middleware ran on every turn (visible in trajectory). System-reminder injection wasn't observed because tasks were marked complete; nothing to anchor. |
| Q137 koi_plan_write | PASS w/ **TUI bug** (see below) | tool called when forced; plan rendered |
| Q138 trajectory | PASS | `middleware:task-anchor`, `middleware:plan`, `middleware:plan-persist` all visible |
| Q139 RunReport | PASS w/ doc nit | report at `$KOI_REPORT_LOG` contains `# Run Report`, summary, duration, token usage. Spec greps for "RunReport" but actual format uses "Run Report" with space. |
| Q140 actions | PASS | 46 model_call/tool_call entries listed |

### S21 Bug fixed

1. **TUI labels `koi_plan_write` as "Write"** — same suffix-matching family as the prior `memory_search` → "Web Search" bug. The `_write` suffix entry in `tool-display.ts` swallows any `*_write` tool. **Fixed**: added explicit entries for `koi_plan_write`, `task_create`, `task_update`, `task_list`.

## S22 — Model Router & Failover

| Q | Result | Notes |
|---|---|---|
| Q141 hello | PASS | response arrives; `/model` shows primary `claude-sonnet-4-6`, fallback `claude-3-haiku` |
| Q142 trajectory router | PASS | step shows `router.target.selected: claude-sonnet-4-6`, `router.fallback_occurred: false`, attempted: [primary] |
| Q143 invalid primary | PASS | TUI doesn't crash; response arrives via fallback |
| Q144 trajectory fallback | PASS | `attempted: [primary, fallback]`, `selected: fallback` |
| Q145 6 failures → CB | **needs re-test** | Earlier analysis ("CB never opens because `failureStatusCodes` excludes 4xx") was wrong: the model-router calls `recordFailure()` with no status code, and `circuit-breaker.ts` counts every undefined-status failure unconditionally. So 5 consecutive primary failures *should* open the CB regardless of HTTP class. If Q145 actually observed primary still being attempted on the 6th turn, the cause is elsewhere (e.g. half-open probe re-arming after `cooldownMs: 60_000` between slow turns; failure not reaching `recordFailure` because the error was caught upstream of fallback). Re-run with breaker telemetry before drawing a conclusion. |
| Q146 both invalid | PASS | "Turn failed (model_stream) — All streaming targets failed."; TUI doesn't crash; rewind option available |

### S22 finding (not a code bug)

CB doesn't open on persistent 4xx failures. This is a design choice (don't trip availability breaker for permanent config errors) but the spec test contradicts it. Suggest tightening the spec: test CB with simulated 503s, not invalid model names.
