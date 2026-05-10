# Governance signal source — design

**Issue:** #1298 part A (System signal adapters)
**Date:** 2026-05-10
**Package:** `@koi/proactive`

## Purpose

Wrap an existing `GovernanceController` as a `SystemSignalSource` so that
sensor threshold crossings emit `SystemSignal{kind: "governance"}` events
to the composition planner. Today governance sensors only **block**
("stop"). This adapter makes them **trigger** ("start").

## Surface

```typescript
export interface GovernanceThreshold {
  /** Governance variable name, e.g. "error_rate", "context_occupancy". */
  readonly sensor: string;
  /** Threshold value compared against the sensor's current reading. */
  readonly limit: number;
  /** Cross direction: "above" → emit when reading > limit; "below" → when reading < limit. */
  readonly direction: "above" | "below";
  /** Per-sensor cooldown after an emission. Default 60_000 (60 s). */
  readonly cooldownMs?: number;
}

export interface GovernanceSignalSourceConfig {
  readonly controller: GovernanceController;
  readonly thresholds: readonly GovernanceThreshold[];
  /** Polling interval. Default 1000 ms. */
  readonly pollIntervalMs?: number;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Injectable timer for tests. Defaults to `globalThis.setInterval`. */
  readonly setInterval?: typeof globalThis.setInterval;
  /** Paired with `setInterval`. Defaults to `globalThis.clearInterval`. */
  readonly clearInterval?: typeof globalThis.clearInterval;
}

export function createGovernanceSignalSource(
  config: GovernanceSignalSourceConfig,
): SystemSignalSource;
```

`SystemSignalSource` is the L0 contract: `{ name, watch(handler, options?) → unsubscribe }`.

## Behavior

### Polling

`GovernanceController` is pull-based (`reading(name) → SensorReading | undefined`),
so this adapter polls. A single shared interval is started lazily on the
**first** `watch()` and cleared when the **last** subscriber unsubscribes.
Subsequent `watch()` calls reuse the running interval.

### Edge detection

Per-sensor state tracks whether the last reading was **inside-bound** or
**outside-bound** relative to the threshold. A signal fires only on a
*transition* from inside to outside (the rising/falling edge), not every
poll while the value remains past the threshold. Re-entry to inside-bound
arms the sensor for the next emission.

### Cooldown

After emitting for a sensor, the source records the emission time and
suppresses further emissions for that sensor for `cooldownMs` even if
re-entry + re-crossing happens within the window. Default `cooldownMs`
is 60_000 (60 s); per-threshold override accepted.

### Emission

```typescript
{
  kind: "governance",
  sensor: threshold.sensor,
  value: reading.current,
  limit: threshold.limit,
  direction: threshold.direction,
  emittedAt: now(),
}
```

Per the `SystemSignalSource` delivery contract, handler invocation is
deferred via `queueMicrotask` so the polling loop does not block on slow
handlers.

### Multiple subscribers

A single polling loop fans out to all registered handlers. Adding or
removing handlers does not restart the loop (only the last unsubscribe
clears the interval).

### Error handling

- **Unknown sensor name:** `controller.reading(name)` returns `undefined`. The
  adapter skips that threshold for the cycle and notifies subscribers'
  `onError` (per `SystemSignalSourceOptions`) with a descriptive `Error`.
  No throw, no signal.
- **Handler throws:** caught by the source loop, forwarded to the
  subscriber's `onError`. Loop continues.
- **`controller.reading` throws:** caught, forwarded via `onError`. The
  next poll tries again — fail-open per the issue's "matching UserSignal
  pattern" requirement.

### Lifecycle

- `watch()` returns an unsubscribe function. Calling it removes the handler
  and, if no handlers remain, clears the interval and resets per-sensor edge
  state (so a future `watch()` starts fresh).
- No explicit `disconnect()` — the L0 contract has none. `onDisconnect`
  callbacks are not fired (the source has no inherent end-of-stream).

## Non-goals

- Event-driven path. This is poll-based; an event API on `GovernanceController`
  would be a separate L0 change.
- Declaring new governance variables. Adapter consumes existing ones only.
- Multi-controller fan-in. One source = one controller; compose at a higher
  level if needed.
- Persistence of edge/cooldown state across process restarts. In-memory only.

## Tests

Unit tests in `governance-signal-source.test.ts`. All deterministic via
injected clock + injected `setInterval`/`clearInterval`.

| # | Test |
|---|------|
| 1 | "above" threshold crossing emits one signal with correct shape |
| 2 | value stays past threshold → no re-emit on subsequent polls |
| 3 | re-entry then re-crossing → re-emits (after cooldown) |
| 4 | re-entry then re-crossing within cooldown → suppressed |
| 5 | "below" threshold crossing emits |
| 6 | multiple sensors fire independently in same poll |
| 7 | multiple subscribers each receive emitted signals |
| 8 | last unsubscribe clears the interval |
| 9 | first watch starts the interval; second watch does not double-start |
| 10 | unknown sensor name → `onError` notified, no throw, no signal |
| 11 | handler throw → `onError` notified, loop continues |
| 12 | `controller.reading` throws → `onError` notified, next poll continues |
| 13 | per-threshold `cooldownMs` overrides default |
| 14 | source `name` is `"governance"` |

## Files

| File | Lines (est.) | Responsibility |
|------|--------------|----------------|
| `packages/lib/proactive/src/governance-signal-source.ts` (new) | ~180 | Factory + edge/cooldown state + polling loop |
| `packages/lib/proactive/src/governance-signal-source.test.ts` (new) | ~280 | All 14 tests above |
| `packages/lib/proactive/src/index.ts` (modify) | +2 | Export `createGovernanceSignalSource`, types |
| `docs/L2/proactive.md` (modify) | +30 | Composition Triggers section |

## Layer compliance

L2 — imports only `@koi/core` (L0). No peer L2, no I/O beyond what the
controller does (and the controller is supplied by the host).
