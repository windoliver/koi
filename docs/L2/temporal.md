# @koi/temporal

Durable agent execution via [Temporal](https://temporal.io). Implements the L0 `SpawnLedger` and `TaskScheduler` contracts backed by Temporal Workflows and Schedules.

## Layer

L2 — imports `@koi/core` only. All `@temporalio/*` types are internal.

## Anti-Leak Guarantee

No `@temporalio/*` types appear in any public export. The public API uses:
- L0 contracts: `SpawnLedger`, `TaskScheduler`
- Structural types: `WorkerLike`, `NativeConnectionLike`, `TemporalClientLike`
- Config types: `TemporalConfig`, `TemporalSchedulerConfig`, `WorkerConfig`

## Exports

| Export | Purpose |
|--------|---------|
| `createTemporalSpawnLedger(config?, initialCount?)` | L0 `SpawnLedger` impl — in-memory slot counter, survives Continue-As-New |
| `createTemporalScheduler(config)` | L0 `TaskScheduler` impl — maps tasks/crons to Temporal Workflows/Schedules |
| `createTemporalWorker(config, activities, workflowsPath, factory?)` | Creates a Temporal Worker handle with lifecycle management |
| `mapTemporalError(error)` | Maps Temporal failure types to `KoiError` |
| `mapKoiErrorToApplicationFailure(err)` | Maps `KoiError` to an `ApplicationFailure` payload for round-tripping |

### `WorkerConfig`

Flat config accepted by `createTemporalWorker`. All fields except `taskQueue` are optional with documented defaults:

```typescript
interface WorkerConfig {
  taskQueue: string;          // required
  url?: string;               // default: "localhost:7233"
  namespace?: string;         // default: "default"
  maxCachedWorkflows?: number; // default: 100
}
```

## SpawnLedger

In-memory slot accounting within an Activity context. The active count is serialized into workflow state refs so it survives [Continue-As-New](https://docs.temporal.io/workflows#continue-as-new).

```typescript
import { createTemporalSpawnLedger } from "@koi/temporal";

const ledger = createTemporalSpawnLedger({ maxCapacity: 10 }, restoredCount);

if (ledger.acquire()) {
  // spawn child workflow
} else {
  // at capacity — queue or reject
}

// On child completion:
ledger.release();

// Serialize into workflow state:
const { activeCount } = ledger.snapshot();
```

## TaskScheduler

Maps Koi task/cron definitions to Temporal Workflows and Schedules. Requires a `TemporalClientLike` — inject the real `@temporalio/client` `Client` at the call site.

```typescript
import { Client } from "@temporalio/client";
import { createTemporalScheduler } from "@koi/temporal";
import { agentId } from "@koi/core";

const client = new Client({ connection });
const scheduler = createTemporalScheduler({ client, taskQueue: "koi-default" });

// One-off task
const id = await scheduler.submit(agentId("my-agent"), { kind: "text", text: "hello" }, "dispatch");

// Cron schedule
const schedId = await scheduler.schedule("0 9 * * 1-5", agentId("report-agent"), { kind: "text", text: "run report" }, "spawn");

// Pause / resume
await scheduler.pause(schedId);
await scheduler.resume(schedId);

// Cleanup
await scheduler[Symbol.asyncDispose]();
```

## Worker Factory

Creates an in-process Temporal Worker. The `@temporalio/worker` import is deferred via dynamic `import()` so this module is testable without the SDK in the module graph.

```typescript
import { createTemporalWorker } from "@koi/temporal";

const handle = await createTemporalWorker(
  { url: "localhost:7233", taskQueue: "koi-default", namespace: "default" },
  myActivities,         // Record<string, ActivityFn>
  new URL("./workflows/index.js", import.meta.url).href,
);

// Start the worker (blocks until shutdown)
void handle.worker.run();

// Graceful shutdown
await handle.dispose();
```

## Error Mapping

Bidirectional mapping between `KoiError` and Temporal failures. `KoiError` is embedded in `ApplicationFailure.details[0]` for round-trip fidelity across the Activity boundary.

| Temporal failure | KoiError code | retryable |
|-----------------|---------------|-----------|
| `TimeoutFailure` | `TIMEOUT` | true |
| `CancelledFailure` | `EXTERNAL` | false |
| `TerminatedFailure` | `EXTERNAL` | false |
| `ServerFailure` | `INTERNAL` | true |
| `ApplicationFailure` (embedded `KoiError`) | original code | original |
| `ApplicationFailure` (other) | `INTERNAL` | per `nonRetryable` flag |

## Design Decisions

**Why in-memory SpawnLedger?** Temporal workflow state must stay under 1 KB for efficient Continue-As-New. The ledger count is a single integer serialized into state refs. For multi-node distributed accounting, use the Nexus-backed ledger from `@koi/ipc-nexus` instead.

**Why structural typing for client/worker?** Avoids `@temporalio/*` in the module graph for packages that only need the contracts (test environments, dry-run mode). The real SDK is injected at the call site.

**Why defer `@temporalio/worker` import?** The Worker SDK has heavy native bindings. Dynamic import lets the module load without the SDK unless a Worker is actually created.

## Testing

All tests run without a live Temporal server — `TemporalClientLike` and `WorkerCreateParams` are injected as mocks.

```bash
bun run test --filter=@koi/temporal
```
