# Phase 3 + Phase 4 Bug Bash — Test Matrix

> Query-driven E2E test plan covering shipped Phase 3 + Phase 4 subsystems.
> TUI-visible behavior runs through tmux. Runtime-only and package-only
> subsystems use direct E2E harnesses and are listed with their required gates.
> This follows the Phase 2 bug bash format in `docs/testing/phase-2-bug-bash.md`.
>
> Cairn-related surfaces are intentionally excluded from this bug bash because
> Cairn is not finished yet. Do not add federation / cross-vault memory / Cairn
> harness tests here until that work is explicitly marked shipped.

---

## 1. Setup

### 1.1 Prerequisites

```bash
bun --version        # >= 1.3.x
node --version       # >= 20.11 for browser native-host smoke
tmux -V              # >= 3.2
docker --version     # Nexus / gateway / Temporal optional suites
gh --version         # to file bugs
jq --version         # transcript parsing
bun install --frozen-lockfile
bun run typecheck && bun run lint && bun run check:layers
```

Optional external services:

| Service | Used by | Required only for |
|---|---|---|
| Nexus container | S5, S6 | Nexus boot modes, gateway-stack E2E |
| Temporal dev server | S7 | Temporal workflow E2E |
| Chrome or Brave | S8 | `@koi/browser-ext` manual smoke |
| Docker daemon | S9 | Docker sandbox adapter smoke |
| Isolated S3 bucket/prefix | S12 | Live S3 artifact backend E2E |
| Playwright browser binary | S17 | Browser driver/a11y/tool smoke |
| Cloud sandbox credentials | S18 | Provider-backed sandbox E2E beyond unavailable-path checks |
| tmux | S19 | Tmux daemon backend and TUI `/bg`/`/supervisor` smoke |

### 1.2 Per-Tester Isolation

```bash
export REPO_ROOT="$PWD"
export WORKTREE=$(basename "$REPO_ROOT")
export TESTER_ID=t1
export NAMESPACE="${WORKTREE}-${TESTER_ID}-p34"
export KOI_SESSION="${NAMESPACE}-koi"
export FIXTURE="/tmp/koi-bugbash-${NAMESPACE}"
export KOI_HOME="/tmp/koi-home-${NAMESPACE}"
export CAPTURE_FILE="/tmp/koi-capture-${NAMESPACE}.txt"
export BUG_LOG="/tmp/koi-bugbash-${NAMESPACE}-bugs.md"
export KOI_BASH_EXTRA_PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin"

rm -rf "$KOI_HOME" "$FIXTURE"
mkdir -p "$KOI_HOME/.koi/sessions" "$FIXTURE"
git -C "$FIXTURE" init -q
git -C "$FIXTURE" \
  -c user.name='koi-bugbash' \
  -c user.email='koi-bugbash@example.invalid' \
  -c commit.gpgsign=false \
  -c core.hooksPath=/dev/null \
  commit --allow-empty -q -m "chore: fixture init"

unset KOI_HOOKS_CONFIG_PATH
unset KOI_DISABLE_HOOKS
```

### 1.3 Launch TUI

> **Model credentials.** The launch `cd`s into `$FIXTURE`, and bun only auto-loads
> `.env` from the current working directory — so the worktree's `$REPO_ROOT/.env` is
> NOT picked up and the TUI falls back to a `dummy` key (model calls fail with HTTP
> 401). Source the repo `.env` into the session (below) or export `OPENROUTER_API_KEY`
> explicitly. With it loaded, the status line reads `… · openrouter` (not `· openai`).

```bash
tmux new-session -d -s "$KOI_SESSION" \
  "set -a; . '$REPO_ROOT/.env'; set +a; cd '$FIXTURE' && HOME='$KOI_HOME' KOI_BASH_EXTRA_PATH='$KOI_BASH_EXTRA_PATH' bun run '$REPO_ROOT/packages/meta/cli/src/bin.ts' tui"
sleep 2
tmux capture-pane -t "$KOI_SESSION" -p | tail -30
```

### 1.4 Reset Between TUI Scenarios

```bash
_FIXTURE_GIT_ROOT=$(git -C "$FIXTURE" rev-parse --show-toplevel 2>/dev/null || echo "")
if [ "$_FIXTURE_GIT_ROOT" != "$FIXTURE" ]; then
  echo "HARNESS ERROR: \$FIXTURE is not an isolated git root: ${_FIXTURE_GIT_ROOT}" >&2
  exit 1
fi

tmux kill-session -t "$KOI_SESSION" 2>/dev/null || true
( cd "$FIXTURE" && git reset --hard -q && git clean -fdq )
rm -rf "$KOI_HOME/.koi/sessions" "$FIXTURE/.koi" "$KOI_HOME/.koi/plugins"
mkdir -p "$KOI_HOME/.koi/sessions"
tmux new-session -d -s "$KOI_SESSION" \
  "set -a; . '$REPO_ROOT/.env'; set +a; cd '$FIXTURE' && HOME='$KOI_HOME' KOI_BASH_EXTRA_PATH='$KOI_BASH_EXTRA_PATH' bun run '$REPO_ROOT/packages/meta/cli/src/bin.ts' tui"
sleep 2
```

### 1.5 Transcript Verification

```bash
SESSION_FILE=$(ls -t "$KOI_HOME/.koi/sessions"/*.jsonl 2>/dev/null | head -1)
jq -r '.role' "$SESSION_FILE" | sort | uniq -c
jq -c 'select(.role=="tool_call")' "$SESSION_FILE" | wc -l
```

### 1.6 Bug Filing Template

Append failures to `$BUG_LOG`:

```markdown
## Sx / Qy — short title
- Tester:
- Commit:
- Setup delta:
- Prompt / command:
- Expected:
- Actual:
- Transcript:
- Logs:
- Severity: P0/P1/P2/P3
```

Severity guide:

| Severity | Meaning |
|---|---|
| P0 | Data loss, permission bypass, secret leak, corrupt persistent state |
| P1 | User-visible broken shipped workflow, crash, hang, unbounded retry |
| P2 | Degraded behavior with workaround, incorrect error envelope, missing telemetry |
| P3 | Cosmetic, docs mismatch, confusing but recoverable behavior |

### 1.7 Corner-Case Execution Rules

Every subsystem scenario below has at least one happy-path check and one
adversarial or boundary check. Run the corner cases even when the happy path
passes; many Phase 3/4 failures only appear during races, restarts, or degraded
dependencies.

For each corner-case row, record:

- Whether the scenario was run against source (`src/bin.ts`) or built artifacts.
- The exact commit under test.
- Any service state change, such as Nexus down/up, Temporal restart, browser
  extension reload, or Docker daemon unavailable.
- The first failing structured error envelope, not only the final model answer.
- A transcript or artifact/log pointer when the test is TUI-visible.

Do not convert an environmental skip into a pass. If a service is missing, run
the documented unavailable/degraded fallback check and mark the service-backed
E2E as `SKIPPED` with the reason.

---

## 2. Shipped Subsystem Coverage

| ID | Subsystem | Phase surface | Primary docs | Coverage mode |
|---|---|---|---|---|
| S1 | `@koi/artifacts` lifecycle | Plan 3 TTL, quota, retention, sweep, scavenger | `docs/L2/artifacts.md` | Direct runtime tool provider + optional TUI |
| S2 | `@koi/artifacts` repair worker | Plan 4 local-only open, `blob_ready=0` repair, `onEvent`, close barrier | `docs/L2/artifacts.md` | Direct DB/FS E2E |
| S3 | Artifact tools in runtime/TUI | L3 wiring of `artifact_save/get/list/delete` | `docs/L3/runtime.md`, `docs/L3/cli.md` | TUI query |
| S4 | `@koi/proactive` delivery | Phase 3 routing + rate limits; Phase 4 quiet hours, high fallback, inbox, timeout, partial success, idempotency metadata | `docs/L2/proactive.md` | Direct E2E harness |
| S5 | Nexus boot lifecycle | Phase 3 health, transport kind, boot modes, audit-poison fail-closed hooks | `docs/L3/runtime.md`, `docs/L3/cli.md` | CLI/Nexus smoke |
| S6 | `@koi/gateway-stack` | Phase 3 gateway + Nexus session store, degradation, health endpoint | `docs/L3/runtime.md` | Scripted gateway E2E |
| S7 | Scheduler / Temporal | Phase 3 durable workflow layer and cron-dispatch routing | `docs/L3/runtime.md`, `docs/L2/scheduler.md`, `docs/L2/scheduler-nexus.md` | Temporal E2E |
| S8 | `@koi/browser-ext` | P3 native host + P4 MV3 service worker | `docs/L2/browser-ext.md` | Manual Chrome smoke + host integration |
| S9 | Sandbox / executor family | Phase 3 docker, subprocess executor, edge/wasm adapters | `docs/L3/runtime.md`, `docs/L2/sandbox-executor.md`, `docs/L2/sandbox-docker.md`, `docs/L2/sandbox-wasm.md` | Direct smoke + golden |
| S10 | Approval zones and permissions hardening | Phase 3 approval-zone evaluator in ask path | `docs/L2/approval-zones.md` | Direct golden + TUI prompt |
| S11 | Context/session repair Phase 4 surfaces | passthrough context engine, interrupt repair | `docs/L2/session-repair.md`, `packages/lib/context-manager` | Direct package E2E |
| S12 | Artifact pluggable blob stores | Plan 5/6 blob backend contract and S3 adapter | `docs/L2/artifacts.md`, `docs/L3/runtime.md` | Direct adapter contract + S3-gated E2E |
| S13 | Proactive tool suite + composition | sleep, cron, monitor, brief, notify, composition planner/executor/checkpoint paths | `docs/L2/proactive.md`, `docs/L3/runtime.md` | Direct provider/composition E2E |
| S14 | Runtime resilience and governance middleware | circuit breaker, call limits, call dedup, governance defaults, policy cache | `docs/L3/runtime.md` | Direct runtime/middleware E2E |
| S15 | Nexus adapter matrix | permissions, escalation, delegation, fs, ipc, registry, search, snapshot, scratchpad, workspace, playbook stores | `docs/L2/*-nexus.md`, `docs/L3/runtime.md` | Adapter contract + live Nexus gated E2E |
| S16 | Gateway HTTP/canvas/webhook | HTTP ingress, canvas state, webhook dispatch, stack lifecycle | `docs/L3/gateway-stack.md` | Scripted gateway-stack E2E |
| S17 | Browser automation surfaces | browser-ext, Playwright driver, a11y helpers, browser tool wrapper | `docs/L2/browser-ext.md`, `docs/L3/runtime.md` | Browser-gated smoke + direct package E2E |
| S18 | Sandbox adapter matrix | router/conformance plus docker, os, wasm, ssh, ipc, cloud adapters and unavailable paths | `docs/L2/sandbox-conformance.md`, `docs/L3/runtime.md` | Conformance + provider-gated E2E |
| S19 | Daemon, background, and supervision | subprocess/tmux/remote backends, `/bg`, `/supervisor`, manifest supervision | `docs/L2/daemon.md`, `docs/L3/runtime.md` | Direct daemon E2E + TUI smoke |

Mark a subsystem `PASS` only when its scenario passes and its listed regression gate in
§5 is green.

### 2.1 Scope Ledger

Use this ledger before signoff. A row may be `SKIPPED` only when the skip reason
is environmental or the surface is explicitly marked not shipped.

| Surface | Status for this bug bash | Required evidence |
|---|---|---|
| Artifact lifecycle, repair, TUI tools, S3/pluggable stores | Covered by S1-S3 and S12 | Q1-Q25, Q104-Q110, artifact gates |
| Proactive delivery, sleep, cron, monitors, briefs, notify, composition | Covered by S4 and S13 | Q26-Q38, Q111-Q120, proactive gates |
| Nexus boot, gateway sessions, adapter matrix | Covered by S5, S6, S15 | Q39-Q56, Q131-Q142, Nexus gates |
| Scheduler and Temporal workflows | Covered by S7 and cross-subsystem stress | Q57-Q65, X1, X4, X7, scheduler gates |
| Browser extension, Playwright, a11y, browser tool | Covered by S8 and S17 | Q66-Q78, Q151-Q157, browser gates |
| Sandbox and executor adapters | Covered by S9 and S18 | Q79-Q87, Q158-Q166, sandbox gates |
| Approval zones, permissions, governance defaults, runtime resilience | Covered by S10 and S14 | Q88-Q95, Q121-Q130, middleware/security gates |
| Context/session repair | Covered by S11 | Q96-Q103, context/session gates |
| Daemon/background/supervision | Covered by S19 | Q167-Q176, daemon/TUI gates |
| Cairn, federation, cross-vault memory | Explicitly excluded | Confirm no Cairn/federation/cross-vault tests were added |

---

## 3. Query Catalog

Each query is sent with:

```bash
tmux send-keys -t "$KOI_SESSION" '<prompt>' Enter
```

### S1 — Artifact Lifecycle Through Runtime Provider

This scenario may be run as the direct integration suite first:

```bash
bun test packages/meta/runtime/src/__tests__/artifacts-integration.test.ts
```

| Q | Prompt / command | Tools Expected | Setup | Pass Criteria |
|---|---|---|---|---|
| Q1 | Direct: save with `policy.ttlMs=50`, wait, call `sweepArtifacts()`, then `artifact_get` | `artifact_save`, `artifact_get` | integration suite | Before TTL get succeeds; after sweep get returns `{ ok:false, error.kind:"not_found" }` |
| Q2 | Direct: save 15 bytes under `maxSessionBytes=20`, then save 10 bytes | `artifact_save` | integration suite | Second save returns structured `quota_exceeded` with `usedBytes=15`, `limitBytes=20`; list count remains 1 |
| Q3 | Direct: create versions A/B/C with `maxVersionsPerName=2`, sweep | store API | one temp store | Oldest version reaped; newest two readable; tombstone only for unreferenced hash |
| Q4 | Direct: create orphan blob via blob backend, run `scavengeOrphanBlobs()` | store API | one temp store | Orphan hash is journaled and drained; live hashes and pending puts are preserved |
| Q5 | Direct: run 100 concurrent saves + 20 sweeps + 2 scavenges | store API | integration suite | All promises settle; no SQLite busy leak; no live artifact references missing blob bytes |
| Q6 | Direct: save zero-byte, 1-byte, and exact-`maxBytes` artifacts | store API | temp store with strict quota | Zero-byte artifact is listable/readable; exact-limit save succeeds; one byte over limit fails without partial row/blob |
| Q7 | Direct: save names with spaces, Unicode, path-like slashes, `..`, and duplicate case variants | store API | temp store | Names round-trip as opaque names; no path traversal on disk; duplicate policy is deterministic |
| Q8 | Direct: delete an artifact while another reader streams `artifact_get` | store API | fake slow blob backend | Reader either completes old bytes or gets structured not-found; no truncated content, unhandled rejection, or leaked lock |
| Q9 | Direct: corrupt blob bytes for a live row, then `artifact_get` and `artifact_list` | store API | temp store with manual blob mutation | Get fails with integrity/corrupt envelope; list remains usable and marks artifact unhealthy if supported |

### S2 — Artifact Startup Recovery + Repair Worker

| Q | Prompt / command | Tools Expected | Setup | Pass Criteria |
|---|---|---|---|---|
| Q10 | Direct: seed stale `pending_blob_puts` older than grace, open store | store open | temp DB | Open touches SQLite only; stale intent without artifact becomes tombstone; fresh intent remains |
| Q11 | Direct: instrument blob store counters, call `createArtifactStore()` | none on open | temp DB with dirty rows | `has/put/delete/list` counters remain 0 during open |
| Q12 | Direct: seed `blob_ready=0`, remove blob, set `maxRepairAttempts=1`, start worker | background worker | integration suite | `repair_exhausted` event fires; row is terminally deleted; tombstone drains |
| Q13 | Direct: make `blobStore.has()` throw for `blob_ready=0` row | background worker | fake blob store | Emits `transient_repair_error`; `repair_attempts` does not increment |
| Q14 | Direct: call `close()` during a slow worker iteration | background worker | fake slow blob store | `close()` waits for iteration and no worker tick runs after close resolves |
| Q15 | Direct: crash-simulate after blob put but before SQLite commit, reopen, repair | temp DB + fake blob store | pending intent exists, no artifact row | Repair makes the orphan path deterministic: either attaches the row or tombstones the blob; repeated repair is idempotent |
| Q16 | Direct: crash-simulate after SQLite row commit but before blob put, reopen, repair | temp DB + missing blob | `blob_ready=0` row | Worker retries until configured cap, emits ordered events, and never serves missing bytes as ready |
| Q17 | Direct: run two repair workers against the same DB | temp DB with dirty rows | two store handles | Only one worker owns each repair; no duplicate tombstones; the losing worker exits or observes lock contention cleanly |
| Q18 | Direct: inject `SQLITE_BUSY` during sweep/repair | fake SQLite wrapper if available | dirty DB | Operation retries or returns structured transient error; next normal sweep repairs remaining state |

### S3 — Artifact Tools in the TUI

The default TUI does not pass an artifact lifecycle policy. This scenario verifies
that the shipped tools are available and that default local store locking degrades
cleanly.

| Q | Prompt | Tools Expected | Setup | Pass Criteria |
|---|---|---|---|---|
| Q19 | `Save an artifact named bugbash-note.txt with content "phase 3 artifact smoke". Then list artifacts.` | `artifact_save`, `artifact_list` | reset | Save succeeds; list shows the artifact bound to this session |
| Q20 | `Get the artifact you just saved and show its content.` | `artifact_get` | same session | Content round-trips exactly |
| Q21 | `Delete that artifact, then try to get it again.` | `artifact_delete`, `artifact_get` | same session | Delete succeeds; get returns not found without crash |
| Q22 | Start a second TUI with the same `$KOI_HOME`; then ask both TUIs to save artifacts | `artifact_save` in first only | same `$KOI_HOME` | First TUI works; second logs artifact store disabled due advisory lock and continues session without aborting |
| Q23 | `Save an artifact larger than the configured session quota, then list artifacts.` | `artifact_save`, `artifact_list` | launch TUI with low artifact quota if flag/env exists | Quota error is visible to the model; list proves no partial artifact was stored |
| Q24 | `Save two artifacts with the same name but different content, then retrieve both versions if available.` | `artifact_save`, `artifact_list`, `artifact_get` | reset | Version semantics are explicit; latest lookup and versioned lookup do not disagree |
| Q25 | Kill the TUI immediately after `artifact_save` starts, relaunch, then list/get | `artifact_save`, `artifact_list`, `artifact_get` | large artifact or slow fake blob backend | Store recovers to either complete artifact or structured repair state; relaunch does not hang |

### S4 — Proactive Delivery Phase 3 + Phase 4

Run as a direct harness because `createProactiveDelivery` is host-wired, not a
default TUI tool.

```bash
bun test packages/lib/proactive/src/proactive-delivery.test.ts
```

| Q | Prompt / command | Setup | Pass Criteria |
|---|---|---|---|
| Q26 | Send `urgent` with 3 channels, one failing | fake adapters | Attempts all channels in parallel; result ok if any succeeds; rate limit not consumed |
| Q27 | Send `high` preferred channel failing, fallback channel succeeding | fake adapters | Preferred attempted first; fallback succeeds; one rate slot consumed |
| Q28 | Send `normal` inside quiet hours | fixed `now()`, timezone | Returns `{ ok:false, reason:"quiet_hours" }`; no adapter call; no rate slot consumed |
| Q29 | Send `normal` outside cross-midnight quiet window | fixed `now()`, timezone | Preferred channel receives exactly one send |
| Q30 | Send `low` with inbox configured and no channels | fake inbox | `inbox.enqueue` receives envelope with `threadId`, `metadata`, `enqueuedAt`; result delivered `["inbox"]`; no `no_channels` |
| Q31 | Adapter timeout for `urgent` with one fast success and one stuck adapter | `sendTimeoutMs` | Result ok with `partialFailures`; stuck promise is abandoned |
| Q32 | Send with `idempotencyKey` | fake adapter + inbox | Key is forwarded in outbound metadata and inbox metadata; delivery layer does not dedupe |
| Q33 | Send `normal` exactly at quiet-hours start, one ms before end, and exactly at end | fixed `now()`, timezone | Boundary behavior is documented and stable; no off-by-one delivery inside quiet hours |
| Q34 | Send with invalid timezone and malformed quiet-hours window | config construction | Config rejects early with actionable error; runtime send path is not partially initialized |
| Q35 | Burst `high` sends until rate limit is exhausted, with first channel failing | fake adapters + small bucket | Failed all-channel deliveries refund or consume exactly as documented; fallback attempts do not bypass the limiter |
| Q36 | Send `urgent` with all channels failing with mixed sync throw, rejected promise, and timeout | fake adapters | Result is `all_failed` with one failure per channel; no unhandled rejection after timeout |
| Q37 | Send `low` with inbox failure and channel failure | fake inbox + adapters | Returns structured failure with both causes; no delivery is reported when nothing committed |
| Q38 | Reuse the same `idempotencyKey` across adapter and inbox paths | fake adapter + fake inbox | Metadata is stable and traceable; no accidental dedupe, mutation, or key loss between attempts |

### S5 — Nexus Boot Lifecycle + Audit Poison

Requires a reachable Nexus test server.

| Q | Command | Setup | Pass Criteria |
|---|---|---|---|
| Q39 | `HOME="$KOI_HOME" bun run "$REPO_ROOT/packages/meta/cli/src/bin.ts" start --nexus-boot-mode telemetry --prompt "ping"` | Nexus up | Startup proceeds; health failures are telemetry only |
| Q40 | `HOME="$KOI_HOME" bun run "$REPO_ROOT/packages/meta/cli/src/bin.ts" start --nexus-boot-mode assert-transport-reachable-at-boot --prompt "ping"` | Nexus down | Startup fails before model call with transport-reachable error |
| Q41 | `HOME="$KOI_HOME" bun run "$REPO_ROOT/packages/meta/cli/src/bin.ts" start --nexus-boot-mode assert-remote-policy-loaded-at-boot --prompt "ping"` | Nexus up, policy missing | Startup fails closed; no disposable `probe` transport is accepted as production |
| Q42 | Direct: force audit sink write failure with fail-closed callback | fake transport | Audit-poison path blocks protected operation and surfaces operator-visible error |
| Q43 | Start with Nexus returning slow health responses beyond timeout | fake/proxy Nexus | Assert mode fails within bounded timeout; telemetry mode logs degraded state and continues |
| Q44 | Start with malformed Nexus policy payload | fake Nexus | Policy load fails closed; error names payload/schema problem and no model call starts |
| Q45 | Flip Nexus from reachable to unreachable during a long `start --prompt` run | proxy Nexus | In-flight run records degradation without corrupting local session; next boot rechecks state |
| Q46 | Configure audit sink fail-open and fail-closed variants with same poison input | fake audit sink | Fail-open emits warning/telemetry and proceeds; fail-closed blocks protected operation; modes never invert |
| Q47 | Run two `start` commands sharing `$KOI_HOME` and Nexus session identifiers | Nexus up | Session IDs remain unique; no cross-run audit/session state is overwritten |

### S6 — Gateway Stack + Nexus Session Store

Prefer the package scripts if available under `packages/net/gateway-stack/scripts/`.

| Q | Command | Setup | Pass Criteria |
|---|---|---|---|
| Q48 | Run gateway-stack soak script | Nexus up | Health endpoint returns 200; sessions persist across stop/start |
| Q49 | Run concurrent storm script | Nexus up | Coalesced write queue drains; no duplicate or out-of-order session records |
| Q50 | Kill gateway mid-flight, restart | Nexus up | Degradation state machine recovers; tombstone delete-cancel-write protection preserves final session state |
| Q51 | Hit `/health` during forced Nexus outage | Nexus toggled down | Returns 503 degraded, then 200 after cooldown/recovery |
| Q52 | Replay duplicate client writes with same session revision | Nexus up | Idempotent write is accepted once; later stale revision is rejected or ignored deterministically |
| Q53 | Delete a session while a queued write for that session is delayed | fake delay in write queue | Delete-cancel-write protection wins; final state is tombstone or deleted, never resurrected stale content |
| Q54 | Restart gateway with partially flushed local queue | kill during flush | Queue drains or discards according to journal; health reflects recovery and no malformed records remain |
| Q55 | Send malformed gateway frames and oversized payloads | gateway test client | Returns structured 4xx/close reason; process stays alive; health endpoint remains accurate |
| Q56 | Run health probes during rapid Nexus flap | Nexus up/down loop | State machine avoids permanent degraded latch after recovery and avoids reporting healthy during known outage |

### S7 — Scheduler + Temporal Durable Workflows

Temporal E2E is env-gated. Skip only if no Temporal service is available and
record the skip in `$BUG_LOG`.

No Docker needed — `temporal server start-dev --ip 127.0.0.1 --port 7233 --headless`
gives a local server. Then run the gated E2E. The env var only reaches the test when
it is NOT stripped by turbo, so use ONE of:

```bash
temporal server start-dev --ip 127.0.0.1 --port 7233 --headless &   # local server
export TEMPORAL_E2E_ADDRESS=127.0.0.1:7233

# (a) file-scoped, archive-safe (env passes through bun directly):
TEMPORAL_E2E_ADDRESS=127.0.0.1:7233 \
  bun test packages/exec/temporal/src/__tests__/e2e.test.ts
# (b) via turbo — works because TEMPORAL_E2E_ADDRESS is in turbo.json passThroughEnv:
bun run test --filter=@koi/temporal
```

> Plain `bun test packages/exec/temporal` also matches `archive/v1/...` (see §5 caveat),
> and a bare `bun run test --filter=@koi/temporal` previously left the E2E rows SKIPPED
> because turbo stripped `TEMPORAL_E2E_ADDRESS` from the test env. Both are now addressed:
> the gate vars (`TEMPORAL_E2E_ADDRESS`, `KOI_E2E_NEXUS`, `DOCKER_E2E`) are in
> `turbo.json` `passThroughEnv`.

| Q | Command | Setup | Pass Criteria |
|---|---|---|---|
| Q57 | Signal into running `agentWorkflow` | Temporal up | Message appends to in-flight queue; workflow remains single long-running owner for `agentId` |
| Q58 | Cron-fired spawn wrapper with overlap | Temporal up | Child exits fast under `ParentClosePolicy.ABANDON`; SKIP overlap does not drop ticks |
| Q59 | `runScheduledTask` retry workflow | Temporal up | Retries follow caller `maxAttempts`/`backoffMs`; terminal failure classified cleanly |
| Q60 | `createTemporalScheduler.querySchedules(agentId)` | Temporal up | Returns all cron schedules for the agent |
| Q61 | Start two workflows for the same `agentId` concurrently | Temporal up | Exactly one owner workflow exists; loser returns existing-workflow signal/result rather than creating split brain |
| Q62 | Send signal after workflow close and after worker restart | Temporal up, restart worker | Closed workflow rejects or starts new run according to documented policy; no lost signal without error |
| Q63 | Cron schedule across DST transition in configured timezone | Temporal up, fixed schedule | Next fire time is deterministic; no duplicate or skipped run beyond Temporal's documented cron semantics |
| Q64 | Schedule with invalid cron, invalid timezone, and unsupported task options | Temporal up | Validation rejects before workflow creation; error explains rejected field |
| Q65 | Cancel schedule while a run is in progress | Temporal up | In-flight run follows parent-close policy; future ticks stop; query no longer lists canceled schedule |

### S8 — Browser Extension P3 Native Host + P4 MV3 Service Worker

Manual smoke is required because the extension attaches to a real user browser.
Use a throw-away Chrome profile.

| Q | Command / action | Setup | Pass Criteria |
|---|---|---|---|
| Q66 | `bun run --cwd packages/drivers/browser-ext build` | clean repo | Host and extension dist files build under Node-compatible targets |
| Q67 | `HOME="$KOI_HOME" bun packages/drivers/browser-ext/dist/bin/koi-browser-ext.js install --dev` | `$KOI_HOME` isolated, Q66 complete | Native messaging manifest, token, admin key, extension assets written with secure modes |
| Q68 | Load unpacked extension from `~/.koi/browser-ext/extension/` | Chrome dev mode | Extension starts without service-worker errors; `installId` persists |
| Q69 | Start native host integration shim | package integration tests | `extension_hello` / `host_hello` handshake validates token and protocol |
| Q70 | Attach to `https://example.com` tab, approve one-time consent | Chrome profile | `list_tabs`, `attach_ack`, CDP snapshot, detach all round-trip; no stale attached debugger remains |
| Q71 | Navigate attached tab to private origin (`http://127.0.0.1`) | same session | Private-origin gate blocks or detaches; no normal grant persists |
| Q72 | Reload extension during pending attach | manual / integration | `cleanup_pending` fencing avoids leaked debugger session; quarantine journal records unresolved detach if needed |
| Q73 | Reinstall extension with new `installId` | manual | Existing `always` and `allow_once` grants are wiped before port ready |
| Q74 | Kill native host while extension port is open, then restart host | Chrome profile | Service worker reports disconnected state, reconnects with fresh handshake, and never reuses stale token challenge |
| Q75 | Attempt native-host handshake with wrong token and wrong protocol version | native host integration | Host rejects before privileged commands; logs are redacted and do not leak admin key/token |
| Q76 | Open two tabs with same origin, grant one-time consent to one tab | Chrome profile | Consent is tab/session scoped; second tab is not implicitly attached |
| Q77 | Extension service worker is suspended between request and response | Chrome devtools/service-worker controls | Pending request times out or resumes with correlation ID; no duplicate command execution |
| Q78 | Browser profile already has stale native manifest from previous install | throw-away profile with stale files | Install overwrites atomically or fails with remediation; manifest points to current `$KOI_HOME` only |

### S9 — Sandbox / Executor Phase 3 Family

| Q | Command | Setup | Pass Criteria |
|---|---|---|---|
| Q79 | `bun test packages/sandbox/sandbox-executor packages/sandbox/sandbox-docker` | Docker optional | Subprocess identity passthrough and TIMEOUT classification pass; Docker unavailable path returns `UNAVAILABLE` cleanly |
| Q80 | `bun test packages/sandbox/sandbox-os` | macOS or Linux | Path-locked execution works; deny-read fixtures enforce file and directory policy |
| Q81 | `bun test packages/sandbox/sandbox-wasm` | local | Trusted class-A workload executes; timeout and memory-section guards fire |
| Q82 | Direct: instantiate Cloudflare adapter stub | no credentials | Experimental constructor returns documented `ADAPTER_NOT_IMPLEMENTED` / `UNAVAILABLE`; no partial deploy |
| Q83 | Run subprocess command that writes stdout/stderr after timeout | sandbox-executor | Timeout classification is stable; late output is drained or ignored without process leak |
| Q84 | Docker image missing, Docker daemon down, and Docker permission denied | sandbox-docker | Each unavailable mode returns distinct structured cause; caller can choose fallback |
| Q85 | OS sandbox tries symlink escape and parent-directory traversal | sandbox-os | Access denied; resolved path is reported safely; no outside file is read or written |
| Q86 | WASM module with huge memory section and infinite loop | sandbox-wasm | Memory guard rejects huge module; timeout kills loop without hanging runner |
| Q87 | Sandbox router receives unsupported adapter kind in manifest | sandbox-router / CLI manifest | Fails before runtime setup with actionable manifest error; no fallback to unsandboxed execution |

### S10 — Approval Zones + Permission Ask Path

| Q | Prompt / command | Tools Expected | Setup | Pass Criteria |
|---|---|---|---|---|
| Q88 | Direct golden: approval-zone evaluator denies high-risk write | permission middleware | package test | Ask path includes zone decision and does not execute tool |
| Q89 | TUI: `Run a harmless echo command.` | Bash + permission prompt if configured | reset | Normal ask path unchanged when no zone evaluator is configured |
| Q90 | TUI with custom manifest enabling zones: request protected destructive command | Bash blocked | zone config | Zone denial wins over broad allow; model receives recoverable denial envelope |
| Q91 | TUI: approve a broad session-level Bash allow, then request zone-protected destructive command | Bash blocked | zone config + prior allow | Zone denial still wins; broad allow is not a bypass |
| Q92 | Direct: overlapping zones where one allows and one denies the same tool/path | permission middleware | golden config | Deny precedence is deterministic and surfaced in the ask envelope |
| Q93 | Direct: malformed zone config and unknown zone action | manifest/config loader | invalid config | Fails closed at config load; no default allow path appears |
| Q94 | TUI: deny a zone prompt, then retry a harmless command | Bash | same session | Denial is scoped to protected action; normal permission path still works |
| Q95 | TUI: interrupt while zone approval prompt is visible | Bash pending approval | tmux Ctrl+C | Tool does not execute after interrupt; next prompt renders cleanly |

### S11 — Context / Session Repair Phase 4

| Q | Command | Setup | Pass Criteria |
|---|---|---|---|
| Q96 | `bun test packages/lib/context-manager/src/passthrough-context-engine.test.ts` | local | Passthrough engine preserves short-session messages and debugging path |
| Q97 | `bun test packages/mm/session-repair` | local | Consecutive same-sender merge and interrupt repair produce valid model transcript |
| Q98 | Direct replay of interrupted turn transcript | fixture transcript | Synthetic assistant boundary inserted where needed; no duplicate user/assistant role violation |
| Q99 | Direct replay with orphan tool result and missing tool call | fixture transcript | Repair preserves auditability and inserts a clear synthetic boundary/error instead of dropping the orphan silently |
| Q100 | Direct replay with very large tool output adjacent to interrupt | fixture transcript | Context engine truncates/segments according to policy; repaired transcript remains valid and bounded |
| Q101 | Resume TUI session after Ctrl+C during streaming assistant text | tmux + session JSONL | Resume shows coherent final turn; no duplicate partial assistant messages are sent to model |
| Q102 | Repair transcript containing malformed JSONL line | fixture transcript | Bad line is quarantined or reported; surrounding valid transcript remains recoverable |
| Q103 | Run two resumes against the same session file | two TUI/CLI starts | One writer owns append; loser fails or waits cleanly; session file remains parseable |

### S12 — Artifact Pluggable Blob Stores + S3 Backend

Run local adapter-contract tests first. Run S3-backed rows only when test
credentials point to an isolated bucket/prefix.

```bash
bun test packages/lib/artifacts-s3 packages/lib/artifacts
```

| Q | Command | Setup | Pass Criteria |
|---|---|---|---|
| Q104 | Run the blob-store contract against local, memory, and S3 adapters | adapter contract harness | All adapters agree on `put`/`has`/`get`/`delete`/`list` semantics and error envelopes |
| Q105 | Save and retrieve an artifact through the S3 backend | isolated S3 bucket/prefix | Bytes, hash, size, content type, and metadata round-trip exactly |
| Q106 | Interrupt after remote blob `put` but before SQLite commit | S3 fake or fault injector | Reopen repair treats the orphan deterministically and repeated scavenges are idempotent |
| Q107 | Interrupt after SQLite commit but before remote blob `put` | S3 fake or fault injector | Artifact is never served as ready until remote bytes exist; repair cap produces terminal state |
| Q108 | S3 returns 403, 404, 409, 429, and 5xx for reads/writes/deletes | fake S3 transport | Errors classify as auth, not-found, conflict, rate-limit, or transient; caller can retry only transient cases |
| Q109 | Two sessions write the same content hash to S3 concurrently | live or fake S3 | Content-addressed write is idempotent; no duplicate metadata rows or corrupted object body |
| Q110 | Delete artifact while S3 delete is slow or fails transiently | fake slow S3 | Local row/tombstone state remains consistent; later scavenger drains or reports the pending delete |

### S13 — Proactive Tool Suite + Composition

These rows extend S4 beyond delivery into the tool/provider layer and
composition engine.

```bash
bun test packages/lib/proactive/src/__tests__/integration.test.ts
bun test packages/lib/proactive/src/__tests__/e2e/composition-e2e.test.ts
```

| Q | Command | Setup | Pass Criteria |
|---|---|---|---|
| Q111 | Create, list, update, cancel a sleep task through `createProactiveToolsProvider()` | fake scheduler | Schedule lifecycle is visible; cancel removes local state and stale schedules do not dedupe future creates |
| Q112 | Create duplicate sleep/cron requests with same idempotency key | fake scheduler | Live schedule dedupes when appropriate; canceled schedule releases the key |
| Q113 | Create cron with invalid expression, invalid timezone, and unsupported task options | provider harness | Validation rejects before scheduling and reports the rejected field |
| Q114 | Create/list/update/cancel monitor with schedule rotation | fake scheduler + wake dispatcher | Update swaps the live schedule atomically; old schedule cannot fire stale monitor text |
| Q115 | Force monitor update rollback when retiring the old schedule fails | fake scheduler returning `removed:false` / throwing | Original monitor record and schedule stay intact; error explains rollback |
| Q116 | Create/list/update/cancel brief with channel delivery | fake scheduler + fake notify channel | Brief wake text includes topic/window; notify channel is required and cancel prevents future delivery |
| Q117 | Run notify through channel resolver churn | dynamic `channel:*` provider set | Tool roster snapshots channels per provider turn; mid-turn channel churn cannot misroute notify |
| Q118 | Composition planner emits spawn, notify, sleep, and schedule steps | composition E2E harness | Execution log records deterministic step keys; replay does not duplicate committed side effects |
| Q119 | Kill composition execution after a committed step, then replay | persisted execution log fixture | Completed steps short-circuit on replay; uncommitted steps resume once; output is stable |
| Q120 | Composition hits session cap, unsupported step, and adapter failure | composition E2E harness | Failure is bounded, classified, and does not poison later independent compositions |

### S14 — Runtime Resilience + Governance Middleware

These are runtime-level Phase 3 hardening surfaces that are easy to miss when
only exercising package-local happy paths.

```bash
bun test packages/lib/middleware-circuit-breaker packages/lib/middleware-call-limits packages/lib/middleware-call-dedup
bun test packages/security/governance-defaults packages/lib/middleware-policy-cache
```

| Q | Command | Setup | Pass Criteria |
|---|---|---|---|
| Q121 | Model provider returns repeated 429/timeout errors, then a healthy response | circuit-breaker harness | Circuit opens, rejects without provider call, enters half-open, and closes after successful probe |
| Q122 | Cancel a half-open streaming probe mid-stream | circuit-breaker stream harness | Probe slot is released; circuit state does not remain stuck half-open |
| Q123 | Exhaust per-tool, global-tool, and model-call budgets | call-limits harness | Limits block with canonical envelope; counters reset on `onSessionEnd` only |
| Q124 | Call dedup cache hit followed by caller mutation of returned object | call-dedup harness | Cached value is deep-cloned; mutation cannot corrupt future responses |
| Q125 | Concurrent identical tool misses plus one request with `signal`/metadata | call-dedup harness | Identical misses coalesce; signal/metadata request bypasses cache and does not populate it |
| Q126 | End session while a deduped call is still in flight | call-dedup harness | Late result cannot repopulate the ended session generation |
| Q127 | Governance defaults trip token, turn, duration, cost, and forge counters | runtime harness with fake governance | Each threshold produces the expected alert/block and reset behavior |
| Q128 | Policy-cache verifier flips from allow to revoke between register and hit | forge policy-cache integration | Hit re-verifies, tombstones stale entry, and emits canonical deny before permissions |
| Q129 | Policy-cache receives stale generation event after newer entry | forge store integration | Stale event is ignored; newer policy remains authoritative |
| Q130 | Compose resilience middleware with permissions and sandbox enforcement | runtime golden harness | Priority order is stable; cache blocks do not enter inner permissions; sandbox-required tools stay hidden when unbacked |

### S15 — Nexus Adapter Matrix

Run package-level contracts against mock transports first. Live Nexus rows are
gated by `KOI_E2E_NEXUS=1`.

```bash
bun test packages/security/permissions-nexus packages/security/permission-escalation-nexus packages/security/nexus-delegation
bun test packages/lib/fs-nexus packages/lib/ipc-nexus packages/security/registry-nexus
bun test packages/lib/search-nexus packages/lib/snapshot-store-nexus packages/lib/scratchpad-nexus packages/lib/workspace-nexus packages/lib/playbook-store-nexus
```

| Q | Command | Setup | Pass Criteria |
|---|---|---|---|
| Q131 | Run each Nexus adapter against its mock transport golden suite | package tests | Adapter maps request/response/error envelopes without leaking transport internals |
| Q132 | Live Nexus smoke for permissions and permission escalation | `KOI_E2E_NEXUS=1` | Grants, denials, escalation records, and audit metadata persist across reconnect |
| Q133 | Delegation adapter concurrent grant/revoke | fake or live Nexus | Last-writer/CAS behavior is deterministic; stale revoke cannot erase newer grant |
| Q134 | FS Nexus read/write/list/delete with malformed paths and large payloads | fake or live Nexus | Paths remain opaque; errors are structured; large payload boundaries are enforced |
| Q135 | IPC Nexus request/response with duplicate correlation ID | fake transport | Duplicate or late response is ignored or classified; no promise leak remains |
| Q136 | Registry Nexus dual-generation CAS conflict and tombstone recovery | package harness | Conflict is surfaced; partial failure tombstones instead of silently downgrading phase |
| Q137 | Search Nexus pagination, `min_score`, and version-skew metadata | package harness | Client-side post-filter preserves score boundary and drops unsafe pagination metadata |
| Q138 | Snapshot store save/list/load/delete with concurrent writers | package harness | Snapshot IDs remain unique; reads never observe partial snapshot body |
| Q139 | Scratchpad Nexus append/read/compact under transport failure | package harness | Failed append is not acknowledged; compaction preserves surviving records |
| Q140 | Workspace Nexus create/attest/verify/invalidate with unhealthy Nexus | package harness | Health gates prevent unsafe fallback; setup attestation cannot be forged |
| Q141 | Playbook store Nexus promotion gate parity with sqlite store | `middleware-ace` integration | Nexus and sqlite adapters produce equivalent promotion decisions for supported features |
| Q142 | Kill Nexus during adapter batch, then reconnect | live Nexus proxy | Adapter reports degraded state and recovers without duplicate side effects |

### S16 — Gateway HTTP, Canvas, and Webhook

S6 covers the stack and Nexus session store. These rows cover the optional
gateway-stack subsystems that ship in the same surface.

```bash
bun test packages/net/gateway packages/net/gateway-http packages/net/gateway-canvas packages/net/gateway-webhook packages/net/gateway-stack
```

| Q | Command | Setup | Pass Criteria |
|---|---|---|---|
| Q143 | Start gateway-stack with HTTP, canvas, webhook, and Nexus enabled | local ports + fake deps | Unified `start()` reports all components healthy and `stop()` tears all down |
| Q144 | Start gateway-stack with canvas omitted and webhook enabled | local ports | Optional subsystem absence is reflected in health without failing the gateway |
| Q145 | Send HTTP ingress request with valid, missing, and malformed auth | gateway-http harness | Valid request dispatches once; invalid auth returns structured 401/403 and no dispatch |
| Q146 | Send oversized and malformed gateway HTTP payloads | gateway-http harness | Returns bounded 4xx; process stays healthy |
| Q147 | Create/update/read/delete canvas surface state | gateway-canvas harness | State versioning is deterministic; concurrent update conflict is reported |
| Q148 | Canvas auth failure during state mutation | gateway-canvas harness | Mutation is rejected before state write; audit/log redacts credentials |
| Q149 | Webhook valid event, duplicate event, bad signature, and slow dispatcher | gateway-webhook harness | Signature gates dispatch; duplicate is idempotent; slow dispatcher times out cleanly |
| Q150 | Kill webhook/canvas subserver while gateway remains up | gateway-stack harness | Stack health degrades only affected component and full stop remains idempotent |

### S17 — Browser Automation Surfaces

S8 remains the manual browser-extension smoke. These rows cover the other
browser packages that appear in shipped runtime/browser surfaces.

```bash
bun test packages/drivers/browser-playwright packages/lib/browser-a11y packages/lib/tool-browser
```

| Q | Command | Setup | Pass Criteria |
|---|---|---|---|
| Q151 | Launch Playwright driver, navigate to static fixture, capture snapshot | local fixture server | Navigation result includes URL/title/body summary and closes browser context |
| Q152 | Browser driver navigation timeout and DNS failure | fake bad URL / short timeout | Error is classified as navigation/timeout, not an unhandled browser crash |
| Q153 | Run browser-a11y audit on accessible and inaccessible fixtures | local fixture pages | Violations are stable and include selectors; accessible fixture stays clean |
| Q154 | Tool-browser request with private origin and file URL | tool harness | Private/local origin policy blocks or asks according to config; no silent navigation |
| Q155 | Tool-browser concurrent page sessions | tool harness | Sessions are isolated; cookies/storage from one session do not bleed into another |
| Q156 | Browser process crash during snapshot | Playwright crash harness | Tool returns structured crash error and cleans temp profile/process handles |
| Q157 | Browser extension attach plus Playwright driver running simultaneously | throw-away Chrome profile | Debugger ownership is clear; neither path steals the other's tab attachment silently |

### S18 — Sandbox Adapter Matrix + Conformance

S9 covers the core adapters. These rows make every shipped adapter either run a
contract or prove its unavailable behavior is honest.

```bash
bun test packages/sandbox/sandbox-conformance packages/sandbox/sandbox-router packages/lib/sandbox-cloud-base
bun test packages/sandbox/sandbox-ssh packages/sandbox/sandbox-ipc packages/sandbox/sandbox-cloudflare packages/sandbox/sandbox-daytona packages/sandbox/sandbox-e2b packages/sandbox/sandbox-vercel
```

| Q | Command | Setup | Pass Criteria |
|---|---|---|---|
| Q158 | Run shared sandbox conformance suite across all locally runnable adapters | local env | Exec basics, cwd/env, stdout/stderr, timeout, and capability honesty pass |
| Q159 | Router selects adapter by manifest and rejects ambiguous manifests | sandbox-router harness | Unsupported or ambiguous adapter fails closed before unsandboxed execution |
| Q160 | SSH adapter with missing binary, auth failure, and pre-aborted signal | no live SSH required | Returns `UNAVAILABLE`/auth/canceled distinctly; no network retry loop |
| Q161 | IPC adapter child exits before handshake and mid-command | sandbox-ipc harness | Parent classifies startup vs runtime failure and drains child process handles |
| Q162 | Cloud base adapter maps provider errors to common causes | fake provider | Auth, quota, rate-limit, timeout, and not-implemented causes match the shared contract |
| Q163 | Cloudflare adapter unavailable/no credentials path | no credentials | Constructor or first run returns documented unavailable/not-implemented status without partial deploy |
| Q164 | Daytona/E2B/Vercel adapters with no credentials and fake success path | fake providers | Unavailable path is honest; fake success path satisfies conformance-required fields |
| Q165 | Provider-backed sandbox tool exposed through middleware-sandbox | runtime harness | Tool is visible only when host explicitly marks that exact tool backed by the provider |
| Q166 | Sandbox command emits huge stdout/stderr and exits after timeout | executor harness | Output is bounded; timeout classification wins; no late output mutates completed result |

### S19 — Daemon, Background, and Supervision

These rows cover Phase 3b runtime/TUI surfaces for background workers and
supervisor visibility.

```bash
bun test packages/net/daemon packages/meta/runtime/src/__tests__
```

| Q | Command | Setup | Pass Criteria |
|---|---|---|---|
| Q167 | Spawn subprocess worker through daemon backend and watch events | daemon harness | `spawn`, `status`, `events`, `terminate`, and `kill` lifecycle events are ordered |
| Q168 | Spawn tmux worker and list through `BackgroundSessionRegistry` | tmux available | `/bg`-equivalent registry shows same worker identity and status as subprocess backend |
| Q169 | Remote backend over Nexus with heartbeat disabled/enabled | fake Nexus transport | Heartbeat-routed workers require explicit support; unsupported backend fails closed |
| Q170 | Kill worker externally, then run supervisor reconcile | daemon harness | Health reports drift; reconciler owns restart and daemon does not double-restart |
| Q171 | Worker terminate ambiguity followed by respawn | daemon harness | Respawn reports conflict until confirmed exit; cached liveness updates only after status poll |
| Q172 | Duplicate lifecycle events across spawn buffer and poll batch | fake backend | Events are deduped; watchers do not receive duplicate terminal transitions |
| Q173 | TUI `/bg` view during worker spawn, exit, and stale heartbeat | tmux TUI | Rows update without stale/flickering identity; detached/unmonitored states render correctly |
| Q174 | TUI `/supervisor` view with healthy, degraded, terminating workers | tmux TUI | Health grouping and worker freshness match daemon snapshots |
| Q175 | Manifest supervision load, update, and removal | runtime harness | Reconciler starts required children, applies removal, and respects restart ownership |
| Q176 | Daemon teardown failure quarantine | daemon harness | Failed teardown is surfaced and quarantined; subsequent stop is idempotent |

## 4. Cross-Subsystem End-to-End Stress

Run these after the per-subsystem scenarios. They intentionally compose shipped
Phase 3/4 surfaces so integration bugs are not hidden by package-only tests.

| ID | Scenario | Setup | Pass Criteria |
|---|---|---|---|
| X1 | TUI saves an artifact, schedules a Temporal follow-up referencing it, then resumes after restart | TUI + artifact store + Temporal | Artifact remains readable after restart; scheduled run receives only artifact metadata/content intended for it |
| X2 | Proactive high-priority fallback fires while Nexus is degraded | fake adapters + Nexus proxy | Delivery succeeds through fallback; Nexus degradation is logged but does not convert delivery to success if all adapters fail |
| X3 | Browser extension snapshot is saved as an artifact, then artifact quota is exceeded | Chrome profile + low quota | Snapshot save succeeds or fails atomically; quota failure does not leave attached debugger or partial artifact |
| X4 | Approval zone denies a sandboxed command requested by a proactive workflow | approval zones + scheduler/proactive harness | Denial is classified as approval-required/denied, not as sandbox crash; retry policy does not loop forever |
| X5 | Gateway session store outage during TUI artifact save and session resume | Nexus/gateway proxy + TUI | Local TUI remains usable; session repair/resume either uses local fallback or reports degraded remote state without corrupting JSONL |
| X6 | Kill the process during simultaneous artifact repair, proactive timeout, and session append | direct harness with fake slow services | All close barriers settle; reopened stores/session logs are parseable; no unhandled rejection appears in stderr |
| X7 | Proactive monitor fires a composition that saves an S3 artifact and notifies a channel | scheduler + proactive + S3 fake + channel fake | Schedule fires once; artifact write is atomic; notification references stable artifact metadata |
| X8 | Runtime call-dedup/call-limits wrap a tool-browser snapshot saved as an artifact | runtime harness + browser fixture | Cache hits do not burn limits; artifact contains the intended snapshot; private-origin gates still apply |
| X9 | Gateway webhook spawns a daemon-supervised worker that uses a Nexus adapter | gateway-stack + daemon + fake Nexus | Webhook dispatch is idempotent; worker lifecycle appears in registry; Nexus failures classify without duplicate spawn |
| X10 | Sandbox router executes a provider-backed tool under approval zones and governance limits | runtime harness + sandbox provider fake | Approval and governance decisions happen before execution; backed-tool visibility is exact and audited |
| X11 | Remote daemon backend loses Nexus during TUI `/supervisor` display | TUI + daemon + Nexus proxy | UI degrades affected backend only; reconnect restores health without duplicate worker rows |
| X12 | Search Nexus result is used by proactive composition and then policy-cache blocks a follow-up tool | fake Nexus + proactive + runtime middleware | Search pagination/score metadata remains stable; policy-cache block stops inner permissions/executor |
| X13 | S3 artifact repair runs while gateway-stack stop tears down canvas/webhook | S3 fake + gateway-stack harness | Both close barriers settle; no late gateway dispatch reads a half-repaired artifact |

## 5. Required Regression Gates

Run these after the query catalog. A Phase 3/4 bug bash is not complete until
every non-skipped gate is green.

> **Runner caveat (read first).** `bun test <path>` treats `<path>` as a
> *substring filter*, so from the repo root it also discovers the archived v1
> mirror under `archive/v1/<path>`. Those archived tests are not workspace
> members, import unlinked deps, and at least one (`archive/v1/packages/net/gateway`)
> **hangs indefinitely** without `--timeout`. This produces spurious failures and
> hangs that look like product regressions but are not. Run each gate through the
> workspace-scoped turbo runner instead — it executes only the package's own
> `src/**` and never touches `archive/`:
>
> ```bash
> bun install                      # required once per worktree (CLAUDE.md §Bun)
> bun run test --filter=@koi/artifacts --filter=@koi/proactive ...   # per gate
> # or the whole suite (archive-safe, content-cached):
> bun run test
> ```
>
> Use the literal `bun test <path>` rows below only when scoped to a single file
> *and* you have confirmed no `archive/v1/<same-path>` exists.

```bash
bun test packages/meta/runtime/src/__tests__/artifacts-integration.test.ts
bun test packages/lib/artifacts
bun test packages/lib/artifacts-s3
bun test packages/lib/proactive
bun test packages/drivers/browser-ext
bun test packages/drivers/browser-playwright packages/lib/browser-a11y packages/lib/tool-browser
bun test packages/exec/temporal
bun test packages/sandbox/sandbox-executor packages/sandbox/sandbox-docker packages/sandbox/sandbox-os packages/sandbox/sandbox-wasm
bun test packages/sandbox/sandbox-conformance packages/sandbox/sandbox-router packages/lib/sandbox-cloud-base packages/sandbox/sandbox-ssh packages/sandbox/sandbox-ipc packages/sandbox/sandbox-cloudflare packages/sandbox/sandbox-daytona packages/sandbox/sandbox-e2b packages/sandbox/sandbox-vercel
bun test packages/net/gateway packages/net/gateway-http packages/net/gateway-canvas packages/net/gateway-webhook packages/net/gateway-stack
bun test packages/net/daemon
bun test packages/lib/middleware-circuit-breaker packages/lib/middleware-call-limits packages/lib/middleware-call-dedup packages/lib/middleware-policy-cache
bun test packages/security/governance-defaults packages/security/permissions-nexus packages/security/permission-escalation-nexus packages/security/nexus-delegation packages/security/registry-nexus
bun test packages/lib/fs-nexus packages/lib/ipc-nexus packages/lib/search-nexus packages/lib/snapshot-store-nexus packages/lib/scratchpad-nexus packages/lib/workspace-nexus packages/lib/playbook-store-nexus
bun test packages/lib/context-manager packages/mm/session-repair
bun run check:layers check:orphans check:golden-queries check:doc-sync check:doc-gate check:doc-wiring
```

External-service skips must be explicit:

| Gate | Skip allowed when | Required note |
|---|---|---|
| Temporal E2E | `TEMPORAL_E2E_ADDRESS` unavailable | Record service unavailable and run unit suite |
| Nexus/Gateway E2E | Nexus container unavailable | Record missing dependency and run package unit/golden tests |
| Browser extension manual smoke | Chrome/Brave unavailable | Record browser unavailable; still run build + native-host tests |
| Docker sandbox | Docker daemon unavailable | Verify unavailable error path |
| S3 artifact E2E | Isolated S3 bucket/prefix unavailable | Run fake S3/adapter contract and record no live S3 credentials |
| Browser Playwright/a11y smoke | Browser binary unavailable | Record missing browser; still run package unit tests where no browser launch is needed |
| Cloud sandbox adapters | Provider credentials unavailable | Run unavailable-path and fake-provider contract rows |
| Daemon tmux backend | `tmux` unavailable | Run subprocess/remote backend rows and record tmux skip |

---

## 6. Corner-Case Coverage Checklist

Use this checklist before declaring the bug bash complete:

- [ ] Boundary values covered: zero, one, exact limit, over limit, empty list, malformed input.
- [ ] Race/restart covered: concurrent writers, interrupted prompts, process kill, service restart.
- [ ] Degraded dependencies covered: Nexus down/slow/malformed, Temporal unavailable/restarted, Docker unavailable, browser host killed.
- [ ] Permission precedence covered: explicit allow, explicit deny, zone deny, broad session allow, interrupt during approval.
- [ ] Persistence covered: reopen after crash, duplicate resume, corrupted JSONL/DB/blob, stale manifest/profile files.
- [ ] Adapter matrices covered: every shipped Nexus, sandbox, browser, gateway, and artifact backend either passed a contract or has an explicit environmental skip.
- [ ] Runtime middleware order covered: resilience, governance, permissions, sandbox, and policy-cache interactions preserve priority and fail-closed behavior.
- [ ] Error envelopes captured before model summarization.
- [ ] Cross-subsystem stress X1-X13 run or skipped with concrete environment reason.
- [ ] No Cairn/federation/cross-vault memory tests added.

## 7. Pass / Fail Signoff

Use this checklist at the end of the run:

- [ ] All TUI scenarios S3 and S10 completed or have filed bugs.
- [ ] Direct E2E scenarios S1, S2, S4, S7, S8, S9, S11-S19 completed, including corner rows, or have documented skips.
- [ ] Nexus/gateway scenarios S5 and S6 completed against a live Nexus, or skipped with dependency note.
- [ ] Cross-subsystem stress scenarios X1-X13 completed or skipped with dependency note.
- [ ] Regression gates in §5 are green for every available dependency.
- [ ] `$BUG_LOG` contains one entry per failure with transcript/log pointers.
- [ ] No P0/P1 remains untriaged.
- [ ] Phase 3/4 coverage table in §2 has an owner signoff for every row.
- [ ] Scope ledger in §2.1 has `PASS`, `SKIPPED`, or `EXCLUDED` status for every shipped or deferred surface.
- [ ] Cairn-related tests remained excluded.
