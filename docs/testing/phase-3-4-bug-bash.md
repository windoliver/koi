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

```bash
tmux new-session -d -s "$KOI_SESSION" \
  "cd '$FIXTURE' && HOME='$KOI_HOME' KOI_BASH_EXTRA_PATH='$KOI_BASH_EXTRA_PATH' bun run '$REPO_ROOT/packages/meta/cli/src/bin.ts' tui"
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
  "cd '$FIXTURE' && HOME='$KOI_HOME' KOI_BASH_EXTRA_PATH='$KOI_BASH_EXTRA_PATH' bun run '$REPO_ROOT/packages/meta/cli/src/bin.ts' tui"
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

Mark a subsystem `PASS` only when its scenario passes and its listed regression gate in
§4 is green.

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

### S2 — Artifact Startup Recovery + Repair Worker

| Q | Prompt / command | Tools Expected | Setup | Pass Criteria |
|---|---|---|---|---|
| Q6 | Direct: seed stale `pending_blob_puts` older than grace, open store | store open | temp DB | Open touches SQLite only; stale intent without artifact becomes tombstone; fresh intent remains |
| Q7 | Direct: instrument blob store counters, call `createArtifactStore()` | none on open | temp DB with dirty rows | `has/put/delete/list` counters remain 0 during open |
| Q8 | Direct: seed `blob_ready=0`, remove blob, set `maxRepairAttempts=1`, start worker | background worker | integration suite | `repair_exhausted` event fires; row is terminally deleted; tombstone drains |
| Q9 | Direct: make `blobStore.has()` throw for `blob_ready=0` row | background worker | fake blob store | Emits `transient_repair_error`; `repair_attempts` does not increment |
| Q10 | Direct: call `close()` during a slow worker iteration | background worker | fake slow blob store | `close()` waits for iteration and no worker tick runs after close resolves |

### S3 — Artifact Tools in the TUI

The default TUI does not pass an artifact lifecycle policy. This scenario verifies
that the shipped tools are available and that default local store locking degrades
cleanly.

| Q | Prompt | Tools Expected | Setup | Pass Criteria |
|---|---|---|---|---|
| Q11 | `Save an artifact named bugbash-note.txt with content "phase 3 artifact smoke". Then list artifacts.` | `artifact_save`, `artifact_list` | reset | Save succeeds; list shows the artifact bound to this session |
| Q12 | `Get the artifact you just saved and show its content.` | `artifact_get` | same session | Content round-trips exactly |
| Q13 | `Delete that artifact, then try to get it again.` | `artifact_delete`, `artifact_get` | same session | Delete succeeds; get returns not found without crash |
| Q14 | Start a second TUI with the same `$KOI_HOME`; then ask both TUIs to save artifacts | `artifact_save` in first only | same `$KOI_HOME` | First TUI works; second logs artifact store disabled due advisory lock and continues session without aborting |

### S4 — Proactive Delivery Phase 3 + Phase 4

Run as a direct harness because `createProactiveDelivery` is host-wired, not a
default TUI tool.

```bash
bun test packages/lib/proactive/src/proactive-delivery.test.ts
```

| Q | Prompt / command | Setup | Pass Criteria |
|---|---|---|---|
| Q15 | Send `urgent` with 3 channels, one failing | fake adapters | Attempts all channels in parallel; result ok if any succeeds; rate limit not consumed |
| Q16 | Send `high` preferred channel failing, fallback channel succeeding | fake adapters | Preferred attempted first; fallback succeeds; one rate slot consumed |
| Q17 | Send `normal` inside quiet hours | fixed `now()`, timezone | Returns `{ ok:false, reason:"quiet_hours" }`; no adapter call; no rate slot consumed |
| Q18 | Send `normal` outside cross-midnight quiet window | fixed `now()`, timezone | Preferred channel receives exactly one send |
| Q19 | Send `low` with inbox configured and no channels | fake inbox | `inbox.enqueue` receives envelope with `threadId`, `metadata`, `enqueuedAt`; result delivered `["inbox"]`; no `no_channels` |
| Q20 | Adapter timeout for `urgent` with one fast success and one stuck adapter | `sendTimeoutMs` | Result ok with `partialFailures`; stuck promise is abandoned |
| Q21 | Send with `idempotencyKey` | fake adapter + inbox | Key is forwarded in outbound metadata and inbox metadata; delivery layer does not dedupe |

### S5 — Nexus Boot Lifecycle + Audit Poison

Requires a reachable Nexus test server.

| Q | Command | Setup | Pass Criteria |
|---|---|---|---|
| Q22 | `HOME="$KOI_HOME" bun run "$REPO_ROOT/packages/meta/cli/src/bin.ts" start --nexus-boot-mode telemetry --prompt "ping"` | Nexus up | Startup proceeds; health failures are telemetry only |
| Q23 | `HOME="$KOI_HOME" bun run "$REPO_ROOT/packages/meta/cli/src/bin.ts" start --nexus-boot-mode assert-transport-reachable-at-boot --prompt "ping"` | Nexus down | Startup fails before model call with transport-reachable error |
| Q24 | `HOME="$KOI_HOME" bun run "$REPO_ROOT/packages/meta/cli/src/bin.ts" start --nexus-boot-mode assert-remote-policy-loaded-at-boot --prompt "ping"` | Nexus up, policy missing | Startup fails closed; no disposable `probe` transport is accepted as production |
| Q25 | Direct: force audit sink write failure with fail-closed callback | fake transport | Audit-poison path blocks protected operation and surfaces operator-visible error |

### S6 — Gateway Stack + Nexus Session Store

Prefer the package scripts if available under `packages/net/gateway-stack/scripts/`.

| Q | Command | Setup | Pass Criteria |
|---|---|---|---|
| Q26 | Run gateway-stack soak script | Nexus up | Health endpoint returns 200; sessions persist across stop/start |
| Q27 | Run concurrent storm script | Nexus up | Coalesced write queue drains; no duplicate or out-of-order session records |
| Q28 | Kill gateway mid-flight, restart | Nexus up | Degradation state machine recovers; tombstone delete-cancel-write protection preserves final session state |
| Q29 | Hit `/health` during forced Nexus outage | Nexus toggled down | Returns 503 degraded, then 200 after cooldown/recovery |

### S7 — Scheduler + Temporal Durable Workflows

Temporal E2E is env-gated. Skip only if no Temporal service is available and
record the skip in `$BUG_LOG`.

```bash
export TEMPORAL_E2E_ADDRESS=127.0.0.1:7233
bun test packages/exec/temporal
```

| Q | Command | Setup | Pass Criteria |
|---|---|---|---|
| Q30 | Signal into running `agentWorkflow` | Temporal up | Message appends to in-flight queue; workflow remains single long-running owner for `agentId` |
| Q31 | Cron-fired spawn wrapper with overlap | Temporal up | Child exits fast under `ParentClosePolicy.ABANDON`; SKIP overlap does not drop ticks |
| Q32 | `runScheduledTask` retry workflow | Temporal up | Retries follow caller `maxAttempts`/`backoffMs`; terminal failure classified cleanly |
| Q33 | `createTemporalScheduler.querySchedules(agentId)` | Temporal up | Returns all cron schedules for the agent |

### S8 — Browser Extension P3 Native Host + P4 MV3 Service Worker

Manual smoke is required because the extension attaches to a real user browser.
Use a throw-away Chrome profile.

| Q | Command / action | Setup | Pass Criteria |
|---|---|---|---|
| Q34 | `bun run --cwd packages/drivers/browser-ext build` | clean repo | Host and extension dist files build under Node-compatible targets |
| Q35 | `HOME="$KOI_HOME" bun packages/drivers/browser-ext/dist/bin/koi-browser-ext.js install --dev` | `$KOI_HOME` isolated, Q34 complete | Native messaging manifest, token, admin key, extension assets written with secure modes |
| Q36 | Load unpacked extension from `~/.koi/browser-ext/extension/` | Chrome dev mode | Extension starts without service-worker errors; `installId` persists |
| Q37 | Start native host integration shim | package integration tests | `extension_hello` / `host_hello` handshake validates token and protocol |
| Q38 | Attach to `https://example.com` tab, approve one-time consent | Chrome profile | `list_tabs`, `attach_ack`, CDP snapshot, detach all round-trip; no stale attached debugger remains |
| Q39 | Navigate attached tab to private origin (`http://127.0.0.1`) | same session | Private-origin gate blocks or detaches; no normal grant persists |
| Q40 | Reload extension during pending attach | manual / integration | `cleanup_pending` fencing avoids leaked debugger session; quarantine journal records unresolved detach if needed |
| Q41 | Reinstall extension with new `installId` | manual | Existing `always` and `allow_once` grants are wiped before port ready |

### S9 — Sandbox / Executor Phase 3 Family

| Q | Command | Setup | Pass Criteria |
|---|---|---|---|
| Q42 | `bun test packages/sandbox/sandbox-executor packages/sandbox/sandbox-docker` | Docker optional | Subprocess identity passthrough and TIMEOUT classification pass; Docker unavailable path returns `UNAVAILABLE` cleanly |
| Q43 | `bun test packages/sandbox/sandbox-os` | macOS or Linux | Path-locked execution works; deny-read fixtures enforce file and directory policy |
| Q44 | `bun test packages/sandbox/sandbox-wasm` | local | Trusted class-A workload executes; timeout and memory-section guards fire |
| Q45 | Direct: instantiate Cloudflare adapter stub | no credentials | Experimental constructor returns documented `ADAPTER_NOT_IMPLEMENTED` / `UNAVAILABLE`; no partial deploy |

### S10 — Approval Zones + Permission Ask Path

| Q | Prompt / command | Tools Expected | Setup | Pass Criteria |
|---|---|---|---|---|
| Q46 | Direct golden: approval-zone evaluator denies high-risk write | permission middleware | package test | Ask path includes zone decision and does not execute tool |
| Q47 | TUI: `Run a harmless echo command.` | Bash + permission prompt if configured | reset | Normal ask path unchanged when no zone evaluator is configured |
| Q48 | TUI with custom manifest enabling zones: request protected destructive command | Bash blocked | zone config | Zone denial wins over broad allow; model receives recoverable denial envelope |

### S11 — Context / Session Repair Phase 4

| Q | Command | Setup | Pass Criteria |
|---|---|---|---|
| Q49 | `bun test packages/lib/context-manager/src/passthrough-context-engine.test.ts` | local | Passthrough engine preserves short-session messages and debugging path |
| Q50 | `bun test packages/mm/session-repair` | local | Consecutive same-sender merge and interrupt repair produce valid model transcript |
| Q51 | Direct replay of interrupted turn transcript | fixture transcript | Synthetic assistant boundary inserted where needed; no duplicate user/assistant role violation |

## 4. Required Regression Gates

Run these after the query catalog. A Phase 3/4 bug bash is not complete until
every non-skipped gate is green.

```bash
bun test packages/meta/runtime/src/__tests__/artifacts-integration.test.ts
bun test packages/lib/artifacts
bun test packages/lib/proactive
bun test packages/drivers/browser-ext
bun test packages/exec/temporal
bun test packages/sandbox/sandbox-executor packages/sandbox/sandbox-docker packages/sandbox/sandbox-os packages/sandbox/sandbox-wasm
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

---

## 5. Pass / Fail Signoff

Use this checklist at the end of the run:

- [ ] All TUI scenarios S3 and S10 completed or have filed bugs.
- [ ] Direct E2E scenarios S1, S2, S4, S7, S8, S9, S11 completed or have documented skips.
- [ ] Nexus/gateway scenarios S5 and S6 completed against a live Nexus, or skipped with dependency note.
- [ ] Regression gates in §4 are green for every available dependency.
- [ ] `$BUG_LOG` contains one entry per failure with transcript/log pointers.
- [ ] No P0/P1 remains untriaged.
- [ ] Phase 3/4 coverage table in §2 has an owner signoff for every row.
- [ ] Cairn-related tests remained excluded.
