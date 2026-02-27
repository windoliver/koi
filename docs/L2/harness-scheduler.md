# @koi/harness-scheduler — Auto-Resume Scheduler for Long-Running Agents

Poll-based scheduler that monitors a `LongRunningHarness` and automatically resumes it when suspended. Configurable poll interval, exponential backoff with jitter on failures, and terminal stop after max retries exhausted.

---

## Why It Exists

`LongRunningHarness.resume()` exists but requires an **external caller**. Without a scheduler, someone (or something) must manually detect when the harness is suspended and call `resume()`. This is the missing glue between "the harness can resume" and "the harness automatically resumes."

`@koi/harness-scheduler` adds **automated multi-session orchestration**:

- **Poll-based detection** — checks harness status at a configurable interval
- **Auto-resume** — calls `resume()` when harness is suspended
- **Exponential backoff** — backs off on failure with jitter to avoid thundering herd
- **Terminal failure** — stops with `"failed"` phase after max retries exhausted
- **Clean shutdown** — respects `AbortSignal`, graceful stop, and idempotent dispose
- **Zero L2 coupling** — uses `SchedulableHarness` structural interface, not `LongRunningHarness` import

Without this package, every autonomous agent deployment would need custom polling logic.

---

## Architecture

`@koi/harness-scheduler` is an **L2 feature package** — it depends only on L0 (`@koi/core`). It avoids importing `@koi/long-running` by defining a minimal structural interface (`SchedulableHarness`) that is duck-type compatible with `LongRunningHarness`.

```
┌──────────────────────────────────────────────────────────────────┐
│  @koi/harness-scheduler  (L2)                                     │
│                                                                    │
│  types.ts        ← SchedulableHarness, Config, Status, Phase      │
│  scheduler.ts    ← createHarnessScheduler() factory + poll loop    │
│  index.ts        ← Public API surface                              │
│                                                                    │
├──────────────────────────────────────────────────────────────────  │
│  Dependencies                                                      │
│                                                                    │
│  @koi/core  (L0)   Result, KoiError                                │
│                                                                    │
│  No dependency on @koi/long-running (L2)                           │
│  SchedulableHarness is structurally compatible via duck typing      │
└──────────────────────────────────────────────────────────────────  ┘
```

---

## How It Works

The scheduler is a **state machine with a poll loop**. It checks harness status on each tick and takes action based on the phase.

```
┌──────────────────────────────────────────────────────────────────┐
│                 Scheduler Phase State Machine                      │
│                                                                    │
│   idle ──start()──> running ──stop()──────────> stopped           │
│                       │                                            │
│                       │ maxRetries exhausted                       │
│                       ▼                                            │
│                     failed                                         │
│                                                                    │
│   running ── harness "completed"/"failed" ──> stopped             │
│   running ── AbortSignal.aborted ──────────> stopped              │
└──────────────────────────────────────────────────────────────────┘
```

### Poll Loop

```
start()
  │
  └── pollLoop():
        while (phase === "running"):
          │
          ├── await delay(pollIntervalMs)       ← configurable, default 5s
          │
          ├── check AbortSignal → stop if aborted
          │
          ├── harnessPhase = harness.status().phase
          │
          ├── terminal ("completed" | "failed") → phase = "stopped", return
          │
          ├── not "suspended" → continue (no action needed)
          │
          └── "suspended":
                │
                ├── await harness.resume()
                │
                ├── success:
                │     totalResumes++
                │     reset retries to maxRetries
                │     reset backoff to base
                │
                └── failure:
                      retries--
                      if retries <= 0 → phase = "failed", return
                      backoff = computeBackoff(prevUpper, base, cap)
                      await delay(backoff)
```

### Backoff Strategy

Exponential backoff with jitter. The **upper bound** doubles deterministically on each failure, and the actual delay is randomized within `[base, upper]`:

```
Attempt  Upper Bound    Actual Delay (random)
  1      base (1s)      [1s, 1s]          ← first failure
  2      2s             [1s, 2s]
  3      4s             [1s, 4s]
  4      8s             [1s, 8s]
  ...    ...            ...
  n      min(cap, 2^n)  [base, upper]      ← capped at backoffCapMs
```

---

## Configuration

```typescript
interface HarnessSchedulerConfig {
  readonly harness: SchedulableHarness;         // The harness to poll and auto-resume
  readonly pollIntervalMs?: number;             // Default: 5000 (5 seconds)
  readonly backoffBaseMs?: number;              // Default: 1000 (1 second)
  readonly backoffCapMs?: number;               // Default: 60_000 (1 minute)
  readonly maxRetries?: number;                 // Default: 3
  readonly signal?: AbortSignal;                // External cancellation
  readonly delay?: (ms: number) => Promise<void>; // Injectable for tests (default: Bun.sleep)
}
```

### SchedulableHarness Interface

The scheduler does not import `LongRunningHarness` from `@koi/long-running`. Instead, it defines a minimal structural interface:

```typescript
interface SchedulableHarness {
  readonly status: () => { readonly phase: string };
  readonly resume: () => Promise<Result<unknown, KoiError>>;
}
```

Any object with these two methods works — including `LongRunningHarness`, mocks, or custom implementations.

---

## Examples

### Basic — Auto-Resume a Harness

```typescript
import { createHarnessScheduler } from "@koi/harness-scheduler";
import { createLongRunningHarness } from "@koi/long-running";

const harness = createLongRunningHarness(config);
const scheduler = createHarnessScheduler({ harness });

// Start polling — scheduler will auto-resume when harness is suspended
scheduler.start();

// ... harness runs, pauses, scheduler detects "suspended", calls resume() ...

// Check status
const status = scheduler.status();
// { phase: "running", retriesRemaining: 3, totalResumes: 2 }

// Graceful shutdown
await scheduler.dispose();
```

### Custom Backoff and Retries

```typescript
const scheduler = createHarnessScheduler({
  harness,
  pollIntervalMs: 2000,     // Check every 2 seconds
  backoffBaseMs: 500,        // Start backoff at 500ms
  backoffCapMs: 30_000,      // Cap at 30 seconds
  maxRetries: 5,             // Allow 5 failures before stopping
});
```

### With AbortSignal

```typescript
const controller = new AbortController();

const scheduler = createHarnessScheduler({
  harness,
  signal: controller.signal,
});

scheduler.start();

// Later: cancel from outside
controller.abort();
// scheduler.status().phase === "stopped"
```

### Testing with Injectable Delay

```typescript
import { describe, expect, test } from "bun:test";

test("resumes harness when suspended", async () => {
  let resumeCalls = 0;
  const harness = {
    status: () => ({ phase: resumeCalls === 0 ? "suspended" : "completed" }),
    resume: async () => {
      resumeCalls += 1;
      return { ok: true as const, value: undefined };
    },
  };

  const scheduler = createHarnessScheduler({
    harness,
    pollIntervalMs: 10,
    delay: () => Promise.resolve(),  // instant delay for tests
  });

  scheduler.start();
  await scheduler.dispose();

  expect(resumeCalls).toBe(1);
});
```

---

## API Reference

### Factory Functions

| Function | Returns | Description |
|----------|---------|-------------|
| `createHarnessScheduler(config)` | `HarnessScheduler` | Creates a new scheduler instance |

### Scheduler Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `start()` | `() → void` | Begin polling (only from "idle" phase) |
| `stop()` | `() → void` | Request graceful stop (sets flag, loop exits on next tick) |
| `status()` | `() → HarnessSchedulerStatus` | Current phase, retries, errors, resume count |
| `dispose()` | `() → Promise<void>` | Stop + await poll loop completion |

### Types

| Type | Description |
|------|-------------|
| `HarnessSchedulerConfig` | `{ harness, pollIntervalMs?, backoffBaseMs?, backoffCapMs?, maxRetries?, signal?, delay? }` |
| `HarnessScheduler` | `{ start, stop, status, dispose }` |
| `HarnessSchedulerStatus` | `{ phase, retriesRemaining, lastError?, totalResumes }` |
| `SchedulerPhase` | `"idle" \| "running" \| "stopped" \| "failed"` |
| `SchedulableHarness` | `{ status, resume }` — minimal structural interface |

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Poll-based (not event-driven) | Harness has no event emitter; poll is simplest and most portable |
| `SchedulableHarness` structural interface | Avoids L2→L2 dependency on `@koi/long-running` |
| Inlined backoff formula | Avoids L2→L1 dependency on `@koi/engine`'s backoff utility |
| Deterministic upper bound tracking | `prevUpper * 2` gives true exponential growth; jitter applied on top |
| Injectable `delay` function | Enables instant test execution without real timers |
| Terminal "failed" phase | Prevents infinite retry loops; caller must intervene |
| `stop()` sets flag, doesn't await | Non-blocking; use `dispose()` to await completion |
| Detect terminal harness phases | Stops polling when harness reaches "completed" or "failed" |

---

## Lifecycle with Long-Running Harness

```
Time ──────────────────────────────────────────────────────────>

Harness:  idle → active ────────> suspended ──────> active ──> completed
                  │                    │                │
                  │ session 1 runs     │                │ session 2 runs
                  │ (LLM calls)        │                │ (LLM calls)
                  │                    │                │
Scheduler:        start()              │                │
                  │                    │                │
                  ├── poll: "active"   │                │
                  │   (no action)      │                │
                  │                    │                │
                  ├── poll: "suspended"│                │
                  │   → resume() ──────┘                │
                  │                                     │
                  ├── poll: "active"                    │
                  │   (no action)                       │
                  │                                     │
                  ├── poll: "completed" ────────────────┘
                  │   → phase = "stopped"
                  │
                  └── (done)
```

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────────────┐
    Result, KoiError                                              │
                                                                   ▼
L2  @koi/harness-scheduler <─────────────────────────────────────┘
    imports from L0 only
    x never imports @koi/engine (L1)
    x never imports @koi/long-running (L2)
    x zero external dependencies
    ~ SchedulableHarness is structural (duck-typed), not imported
    ~ package.json: { "dependencies": { "@koi/core": "workspace:*" } }
```
