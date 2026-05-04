# TUI Daemon Surface (#1944)

**Branch:** `feat/tui-daemon-surface-1944`
**Issue:** [#1944](https://github.com/windoliver/koi/issues/1944) — v2 Phase 3b-8: TUI daemon surface
**Status:** Design approved, ready for implementation plan

## Summary

Surface the `@koi/daemon` subsystem in `@koi/tui`. Today the daemon ships
supervisors, session registries, and heartbeat health, but a TUI user spawning
a subagent sees nothing about supervision — no crash recovery signal, no
isolation visibility, no health insight. This PR makes the daemon observable.

## Scope

Single PR. Two halves:

### Half A — Runtime wiring (prerequisite)

Issue #1866 closed with an in-process stub (`wire-manifest-supervision.ts`).
The actual `@koi/daemon` `Supervisor` is never instantiated in production.
Per the doc comment in that file, end-to-end activation was deferred to #1944.
This PR completes it.

- Instantiate `createSupervisor` (`@koi/net/daemon`) in the CLI bootstrap when
  loaded manifest declares `supervision:` with at least one child whose
  `isolation === "subprocess"`.
- Wire `attachRegistry` to a `createFileSessionRegistry({ dir })` so
  `koi bg ps/logs/kill` becomes useful in tandem.
- Expose the supervisor handle from the CLI bootstrap so the daemon-bridge
  (Half B) can subscribe to it. TUI itself never holds the handle.
- In-process-only manifests (no subprocess children) skip daemon
  instantiation — the existing in-memory wiring continues to drive the
  `/agents` Supervised section.

### Half B — TUI surface

Six features per the issue:

1. **Status-line indicator** — supervisor health badge + worker counts on
   right side of `StatusBar.tsx`. Hidden when no supervisor attached.
2. **Alert toasts** — `crashed`, `quarantined`, and ok→degraded/unhealthy
   transitions. Dedup per `(sessionId, workerId, kind)` with TTL 30s.
3. **`/supervisor`** — full-screen, read-only: health + reasons, worker
   table, last-50 event feed, backend kinds. Mutation actions deferred.
4. **`/bg`** — full-screen: `FileSessionRegistry.list()` merged with live
   health, freshness badge per row, `Enter` tails logs in-TUI, `k` triggers
   kill confirm prompt that routes through the bridge.
5. **Spawn tool output enrichment** — show `workerId`, isolation mode,
   backend kind on Spawn tool result rendering.
6. **Session log inline events** — supervisor lifecycle events (`started`,
   `crashed`, `restarting`, `quarantined`, `stopped`) rendered inline in
   the session log with the subagent name.

## Architecture

```
                    Manifest declares supervision: with subprocess isolation
                                          │
                                          ▼
  CLI bootstrap (packages/meta/cli/src/) ─── instantiates ───┐
                                          │                  │
                                          ▼                  ▼
                            createSupervisor          createFileSessionRegistry
                            (@koi/net/daemon)          (@koi/net/daemon)
                                          │                  │
                                          └─── attachRegistry ┘
                                          │
                                          ▼
                  daemon-bridge.ts (NEW, packages/meta/cli/src/)
                                          │
                  ┌───────────────────────┼───────────────────────┐
                  │                       │                       │
            supervisor.events()   supervisor.health()    registry.list()
            (subscribe)              (poll 1s)             (poll 1s)
                  │                       │                       │
                  ▼                       ▼                       ▼
                          TuiStore dispatches
              ─────────────────────────────────────────────
              push_supervisor_event   set_supervisor_health
              set_bg_rows             push_toast (deduped)

                  ▲                                       │
                  │ requestKill(sessionId)                │
                  │                                       ▼
            onCommand("system:bg-kill")          TUI views render
            handler in tui-root                  StatusBar / SupervisorView /
                                                 BgView / Toast
```

### Layer compliance

- **L0** types (`Supervisor`, `WorkerEvent`, `SupervisorHealth`,
  `WorkerSnapshot`, `BackgroundSessionRegistry`) already live in
  `@koi/core/daemon` — TUI imports types only, no L2-on-L2 dependency.
- **L2 `@koi/tui`** holds state slices + view components. No runtime handles.
- **L3 `@koi/meta-cli`** owns the bridge and instantiation. Already imports
  `@koi/net/daemon` (verified — file `daemon-spawn-child-fn.ts` referenced).
- **One interposition layer** preserved — bridge uses public Supervisor API
  (`events()`, `health()`, `list()`, `stop()`); no new hooks.

## File Layout

```
packages/meta/cli/src/
  daemon-bridge.ts                  NEW  ~220 LOC
                                         Subscribes events; polls health +
                                         registry; dispatches into store;
                                         exposes onCommand handler.
  wire-daemon-supervisor.ts         NEW  ~180 LOC
                                         Composes createSupervisor +
                                         createFileSessionRegistry +
                                         attachRegistry. Returns handle +
                                         dispose. Skipped when no subprocess
                                         children declared.
  bin.ts                            EDIT  ~30 LOC
                                         Wire wireDaemonSupervisor +
                                         createDaemonBridge into the TUI
                                         startup path; dispose in graceful
                                         shutdown.

packages/ui/tui/src/
  state/types.ts                    EDIT  ~80 LOC
                                         Add SupervisorSlice, BgSessionsSlice,
                                         supervisor + bg view kinds, dispatch
                                         action discriminants.
  state/initial.ts                  EDIT  ~12 LOC
  state/reduce.ts                   EDIT  ~120 LOC
                                         Handle new actions; ring buffer cap
                                         50 for events; freshness compute.
  state/mutations.ts                EDIT  ~30 LOC
  components/StatusBar.tsx          EDIT  ~40 LOC
                                         Render badge ◎/◑/● + count after
                                         existing governance segment.
  components/SupervisorView.tsx     NEW  ~250 LOC
                                         Health header + reasons + worker
                                         table + event feed + backend list.
  components/BgView.tsx             NEW  ~280 LOC
                                         Row table + freshness color +
                                         confirm modal + tail pane mount.
  components/BgLogTail.tsx          NEW   ~80 LOC
                                         fs.watch + initial tail-N read +
                                         component-local ring buffer.
  tui-root.tsx                      EDIT  ~50 LOC
                                         View dispatch for "/supervisor",
                                         "/bg"; "system:bg-kill" routing;
                                         tail key handling.
  commands/command-definitions.ts   EDIT  ~25 LOC
                                         Register /supervisor, /bg,
                                         system:bg-kill.
  tool-display.ts                   EDIT  ~40 LOC
                                         Spawn tool result enrichment.

Tests
  packages/meta/cli/src/daemon-bridge.test.ts                NEW
  packages/meta/cli/src/wire-daemon-supervisor.test.ts       NEW
  packages/ui/tui/src/state/reduce.test.ts                   EDIT
  packages/ui/tui/src/components/StatusBar.test.tsx          EDIT
  packages/ui/tui/src/components/SupervisorView.test.tsx     NEW
  packages/ui/tui/src/components/BgView.test.tsx             NEW
  packages/ui/tui/src/__tests__/daemon-tui-e2e.test.ts       NEW (gated)
```

**Total estimate:** ~1150 LOC (within CLAUDE.md's <1500 ceiling).

## State Slices

```typescript
// packages/ui/tui/src/state/types.ts (additions)

import type {
  SupervisorHealth,
  WorkerEvent,
  WorkerSnapshot,
  WorkerBackendKind,
} from "@koi/core/daemon";

const SUPERVISOR_EVENT_BUFFER_CAP = 50;

type BridgeStatus =
  | { readonly kind: "detached" }   // no supervisor in this session
  | { readonly kind: "live" }       // last poll succeeded
  | { readonly kind: "stale"; readonly since: number; readonly reason: string };
                                    // bridge attached but data plane failing

interface SupervisorSlice {
  readonly attached: boolean;       // false ⇔ status.kind === "detached"
  readonly status: BridgeStatus;    // distinguishes detached from unavailable
  readonly health: SupervisorHealth | null;  // last-known; not cleared on failure
  readonly events: readonly SupervisorEventEntry[];
}

interface SupervisorEventEntry {
  readonly id: string;
  readonly ts: number;
  readonly kind: WorkerEvent["kind"];
  readonly workerId: string;
  readonly agentName: string;
  readonly detail?: string;
}

interface BgSessionRow {
  readonly sessionId: string;
  readonly workerId: string | null;
  readonly status: "starting" | "running" | "exited" | "crashed";
  readonly pid: number | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly lastHeartbeatAt: number | null;
  readonly logPath: string;
  /**
   * `pending`  — no heartbeat yet AND within `2 * heartbeatDeadlineMs` of
   *              `startedAt` (worker still booting, OR registry-only entry
   *              that has not registered with the supervisor yet).
   * `ok`       — heartbeat received within deadline.
   * `stale`    — heartbeat older than deadline but under 2× deadline.
   * `timeout`  — heartbeat older than 2× deadline OR no heartbeat past the
   *              `pending` grace window OR status `crashed`/`exited`.
   */
  readonly freshness: "pending" | "ok" | "stale" | "timeout";
  readonly backendKind: WorkerBackendKind | null;
}

interface BgSessionsSlice {
  readonly rows: readonly BgSessionRow[];
  readonly tailingSessionId: string | null;
  readonly killConfirm: { sessionId: string } | null;
}
```

Dispatch actions:

- `set_supervisor_attached: { attached: boolean }`
- `set_supervisor_status: { status: BridgeStatus }`
- `set_supervisor_health: { health: SupervisorHealth | null }`
- `push_supervisor_event: { entry: SupervisorEventEntry }` (caps buffer)
- `clear_supervisor_events`
- `set_bg_rows: { rows: readonly BgSessionRow[] }`
- `set_bg_tailing: { sessionId: string | null }`
- `set_bg_kill_confirm: { confirm: { sessionId: string } | null }`

Toasts reuse existing `push_toast` action — no new shape.

## Data Flow Details

### Bridge poll cadence
- `supervisor.health()` → 1s interval (cheap snapshot).
- `registry.list()` → 1s interval (FS read; debounced if last call took
  >250ms).
- `supervisor.events()` → push subscription, no polling.
- All intervals stop on `bridge.close()`.

### Bridge failure handling

Every poll and the event subscription wrap their work in try/catch. The
bridge **never** silently clears state on failure; instead it preserves the
last-known snapshot and flags the surface as stale.

| Failure | Action |
|---------|--------|
| `health()` rejects or throws | Increment `healthFailureCount`. After 3 consecutive failures (≈3s), dispatch `set_supervisor_status({ kind: "stale", since: firstFailureAt, reason })`. Keep `health` slice unchanged so the worker table does not blink empty. Log via existing logger. |
| `registry.list()` rejects | Same pattern: 3-strike → `stale` status; keep last `rows`. Toast once per stale transition: `"⚠ background session registry unavailable"`. |
| `supervisor.events()` subscription ends unexpectedly | Treat as terminal for that subscription. Dispatch stale; attempt resubscribe with backoff (1s, 2s, 5s, 5s …). If 5 reconnects fail, leave stale and stop trying — operator must restart the TUI. |
| Recovery (any successful poll after a failure) | Reset failure counter; dispatch `set_supervisor_status({ kind: "live" })`; toast `"✓ supervisor connection restored"` only if previously stale. |

Status-line rendering uses `status.kind`:
- `detached` → segment hidden (current behavior).
- `live` → badge ◎/◑/● per `health.status`.
- `stale` → badge `◌` (open circle) plus `"stale Ns"` countdown — explicit
  signal that observability is broken, not that everything is healthy.

This rules out the failure mode where a dead bridge silently presents as
"no supervisor attached".

### Toast triggers (bridge maps WorkerEvent → toast)

| Trigger | Message |
|---------|---------|
| `WorkerEvent.crashed` | `⚠ worker <agentName> crashed` |
| `WorkerEvent.quarantined` | `⚠ worker <agentName> quarantined after <N> restarts` |
| `health.status` ok→degraded | `⚠ supervisor degraded: <first reason>` |
| `health.status` ok→unhealthy | `⚠ supervisor unhealthy: <first reason>` |

Dedup key: `${sessionId}:${workerId}:${kind}`. TTL 30s. Reuses existing
governance dedup helper if extractable; otherwise a tiny local map.

### Freshness computation

Per row, at dispatch time (not render). `heartbeatDeadlineMs` read from
supervisor config via `health()` snapshot. Treat `lastHeartbeatAt === null`
explicitly — never coerce to `0`.

```
if (status === "crashed" || status === "exited") return "timeout";
if (lastHeartbeatAt === null) {
  // No heartbeat yet. Allow a grace window from startedAt before flipping red.
  if (now - startedAt < 2 * heartbeatDeadlineMs) return "pending";
  return "timeout";
}
const age = now - lastHeartbeatAt;
if (age < heartbeatDeadlineMs) return "ok";
if (age < 2 * heartbeatDeadlineMs) return "stale";
return "timeout";
```

`pending` renders neutral (no color flag) so booting workers and
registry-only entries do not falsely alarm before their first heartbeat.

### Kill flow

The selected `BgSessionRow` carries `workerId` from the last poll merge —
that snapshot can be stale by the time the user confirms. Resolution must
happen at execution time against the **live supervisor snapshot**, not the
cached registry row.

1. `BgView`: user presses `k` → dispatch
   `set_bg_kill_confirm({ sessionId, expectedWorkerId })` where
   `expectedWorkerId` captures the worker the operator intended to stop.
2. Modal renders. `y` → call
   `onCommand("system:bg-kill", { sessionId, expectedWorkerId })`.
3. `tui-root` routes to `bridge.requestKill({ sessionId, expectedWorkerId })`.
4. Bridge resolves the **current** mapping:
   - `entry = await registry.get(sessionId)`; if absent OR
     `entry.status !== "running"`/`"starting"`, dispatch a `push_toast`
     `"⚠ session <id> already terminated"` and return without calling stop.
   - `currentWorkerId = entry.workerId`. If `currentWorkerId !== expectedWorkerId`
     (the worker was restarted between selection and confirm), dispatch
     `"⚠ session <id> rebound to a new worker; refresh and try again"`
     and return — never stop a worker the operator did not pick.
5. Bridge calls `supervisor.stop(currentWorkerId, "user-requested")`. If
   the call rejects (worker already gone, supervisor shutting down), catch
   and surface as a toast; do not crash the bridge.
6. Supervisor emits `stopped`; bridge dispatches event + the next poll
   refreshes status.
7. `n` or Esc → dispatch `set_bg_kill_confirm({ confirm: null })`.

### Log tail

`Enter` on row → dispatch `set_bg_tailing({ sessionId })` → `BgLogTail`
mounts.

- Initial: read last 1000 lines from `logPath`.
- Watch: `fs.watch(logPath)` on Bun; on `change` event, read appended bytes.
- Fallback: if no events fire within 5s, switch to `setInterval(stat+read)`
  at 500ms.
- Component-local ring buffer (cap 1000 lines). Esc returns to row list.

## Hidden status-line

When `supervisor.health()` returns `null` (no supervisor attached) or
`attached === false`, status-bar render skips the supervisor segment. Order
on the right side: governance segment, then supervisor segment, separator
`·`. No layout collision since both segments self-elide when empty.

## Testing

### Unit tests (bun:test, colocated)

- **`reduce.test.ts`** — new actions update slices; events ring buffer caps
  at 50; bg row freshness boundaries (pending/ok/stale/timeout) including
  null `lastHeartbeatAt` grace window and crashed/exited → timeout.
- **`StatusBar.test.tsx`** — badge renders ◎/◑/● per `health.status` when
  bridge `live`; renders `◌ stale Ns` when bridge `stale`; segment hidden
  when `detached`; format `"3/5 workers"`.
- **`SupervisorView.test.tsx`** — worker table columns; reasons section
  hidden when empty; event feed last-N order.
- **`BgView.test.tsx`** — registry rows merged with health workers; kill
  modal flow; Enter triggers tailing dispatch.
- **`daemon-bridge.test.ts`** — `WorkerEvent.crashed` triggers `push_toast`
  + `push_supervisor_event`; same crash within 30s deduped to 1 toast;
  `health` ok→degraded transition fires toast (not on every tick); kill
  resolves workerId via live registry, refuses when session terminated or
  rebound to a different worker (no-op + warn toast), surfaces
  `supervisor.stop` rejection as toast without crashing; 3 consecutive
  `health()` failures flip status to `stale` while preserving last snapshot;
  recovery flips back to `live` with restored toast; events subscription
  loss triggers backoff resubscribe (1s, 2s, 5s, 5s); `close()`
  unsubscribes + clears intervals.
- **`wire-daemon-supervisor.test.ts`** — manifest with subprocess child
  instantiates daemon + registry + bridge; manifest with only in-process
  children skips daemon; dispose tears down in reverse order.

### E2E (tmux harness, gated on `$RUN_E2E`)

`packages/ui/tui/src/__tests__/daemon-tui-e2e.test.ts`:

- manifest with subprocess supervision → `◎ ok` badge appears.
- `os.kill` worker → `⚠` toast + status flips to `◑`.
- Stall worker past heartbeat deadline → timeout toast + `/bg` row red.
- `/supervisor` renders worker tree with uptime + restart counts.
- `/bg` table merges registry + health; `k` confirm terminates worker;
  row flips to `exited`.
- Manifest without `supervision:` → no badge.

### Coverage target

≥80% per `bunfig.toml`. Bridge + reducer get the tightest assertions; views
snapshot-tested.

### Golden trajectory

Skipped — TUI surface is observability over runtime, no new model/tool
calls. Existing daemon golden queries cover supervisor lifecycle.

## Risks

| Risk | Mitigation |
|------|------------|
| Polling at 1s × 2 in idle TUI | Bridge stops polls when `attached:false` and on `close()`. Acceptable for v1; switch to event-driven later. |
| `fs.watch` macOS rename quirks | Fallback to `stat+read` polling at 500ms after 5s of no events. Cap tail buffer at 1000 lines. |
| Spawn tool output needs `workerId` | Verify Spawn tool result schema during impl; thread `workerId`/`backendKind` through if missing. Small adjacent change if needed. |
| Status-bar collision with `/governance` badge | Both render right-side; explicit ordering: governance first, supervisor second, separator `·`. Each segment self-elides. |
| Test flakiness on tmux E2E | Gate on `$RUN_E2E`; CI keeps unit tests as source of truth for #1944 acceptance. |
| Toast spam on rapid restart loops | 30s TTL dedup per `(sessionId, workerId, kind)`. Quarantine event always shown (terminal state). |

## Out of Scope

- Mutation UI in `/supervisor` (interactive restart/resume) — issue defers.
- Cross-session aggregation (supervised trees across user sessions) — Phase 4.
- Historical log retention beyond `FileSessionRegistry`'s 24h sweep.
- Remote/tmux backends — future Phase 3b-6+.
- Replacing the existing in-process stub in `wire-manifest-supervision.ts`
  for in-process-only manifests — out of scope; that path keeps the
  `/agents` Supervised section as today.

## Dependencies

- **#1338** (supervisor + worker management) — shipped.
- **#1340** (session registry + `koi bg` CLI) — shipped.
- **#1341** (heartbeat + health) — shipped.
- **#1866** (manifest.supervision wired into runtime + TUI for in-process
  stub path) — shipped, but real daemon supervisor never instantiated.
  This PR completes the gap.
- **#1876** (governance TUI surface) — UX precedent for status-line and
  full-screen views; align terminology.

## Acceptance

- [ ] All anti-leak rules from CLAUDE.md hold (no L2-on-L2; no L1 imports
      from TUI; types-only L0 imports).
- [ ] `bun run typecheck`, `bun run lint`, `bun run check:layers`,
      `bun run check:unused`, `bun run check:duplicates` pass.
- [ ] Unit + integration tests pass with ≥80% coverage on touched files.
- [ ] tmux E2E suite runs green when `$RUN_E2E` set.
- [ ] Manifest with `supervision:` + subprocess child shows `◎` badge in
      TUI status line within 1s of startup.
- [ ] Killing a supervised worker via `os.kill` produces a toast within
      heartbeat deadline + 1s.
- [ ] `/bg` `k` flow terminates a worker and updates the row to `exited`.
- [ ] Manifest without `supervision:` renders no badge and no daemon
      lifecycle events in the session log.
