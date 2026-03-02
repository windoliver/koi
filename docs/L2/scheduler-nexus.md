# @koi/scheduler-nexus — Nexus-Backed Priority Queue for Task Dispatch

Implements the L0 `TaskQueueBackend` contract using Nexus Astraea as the priority queue for scheduled task dispatch. Koi retains ownership of cron timing, retry logic, and dead-letter semantics. Nexus handles 5-tier priority ordering, aging, credit-based boost, HRRN scoring, and fair-share admission control.

---

## Why It Exists

In a single-node Koi deployment, the scheduler uses a local in-memory min-heap for priority ordering. Tasks are dispatched directly from the heap to the local agent runtime. This works well for one process but breaks down when agents run across multiple nodes.

Without this package, you'd need to:
1. Build a distributed priority queue with deduplication
2. Map Koi's task priority model to your queue backend
3. Handle idempotency for cron-fired tasks across restarts
4. Implement fair-share admission control to prevent agent starvation
5. Thread connection management (timeouts, retries, auth) through your HTTP layer
6. Do all of the above while respecting Koi's layer architecture (L2 imports L0 only)

`@koi/scheduler-nexus` handles all of this. Point it at a Nexus Astraea server and task dispatch scales across any number of nodes.

---

## What This Enables

### Before vs After

```
BEFORE: local heap, single-node dispatch
════════════════════════════════════════

  ┌────────────────────────────────────────┐
  │  Node 1 (only node)                    │
  │                                        │
  │  ┌──────────┐    ┌──────────────────┐  │
  │  │  Cron    │───▶│  Local Min-Heap  │  │
  │  │  Timer   │    │  ┌────┐ ┌────┐   │  │
  │  └──────────┘    │  │ P0 │ │ P5 │   │  │
  │                  │  └────┘ └────┘   │  │
  │  ┌──────────┐    │  ┌────┐ ┌────┐   │  │
  │  │  submit()│───▶│  │ P3 │ │ P9 │   │  │
  │  └──────────┘    └───────┬──────────┘  │
  │                          │ poll()      │
  │                          ▼             │
  │                  ┌──────────────────┐  │
  │                  │  Local Dispatch  │  │
  │                  │  (dispatcher fn) │  │
  │                  └──────────────────┘  │
  └────────────────────────────────────────┘

  Single process. No cross-node visibility.
  Priority = simple numeric comparison.


AFTER: Nexus Astraea owns the queue, Koi owns timing
═════════════════════════════════════════════════════

  Node 1                          Node 2
  ┌───────────────────┐           ┌───────────────────┐
  │  Cron ──▶ submit()│           │  submit() ────────│──┐
  │       │           │           │                   │  │
  │       ▼           │           └───────────────────┘  │
  │  enqueueTask()    │                                  │
  │       │           │                                  │
  └───────┼───────────┘                                  │
          │ POST /api/v2/scheduler/submit                │
          ▼                                              ▼
  ┌──────────────────────────────────────────────────────────┐
  │                  Nexus Astraea                           │
  │                                                          │
  │  5-tier priority + aging + HRRN + fair-share admission   │
  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐          │
  │  │ Tier0│ │ Tier1│ │ Tier2│ │ Tier3│ │ Tier4│          │
  │  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘          │
  │                                                          │
  │  Deduplication via idempotency keys                      │
  │  Credit-based boost prevents starvation                  │
  └──────────────────────────────────────────────────────────┘

  Koi retains: cron timing, retry backoff, dead-letter, timeout
  Nexus handles: priority ordering, admission control, dedup
```

---

## How It Works

### Task Lifecycle

```
submit() or cron fire
  │
  ├─ Build ScheduledTask (id, priority, input, mode)
  │
  ├─ Generate idempotency key (cron only): "{scheduleId}:{timestamp}"
  │
  ├─ queueBackend present?
  │   ├─ YES: POST /api/v2/scheduler/submit → Nexus
  │   │       Body: { task_id, agent_id, priority, mode, metadata, idempotency_key }
  │   │       Nexus assigns queue position, returns task ID
  │   │       Local heap is NOT used (Nexus is sole queue)
  │   │
  │   └─ NO:  store.save(task) + heap.insert(task)
  │           Local poll() dispatches when ready
  │
  └─ emit("task:submitted")


cancel(taskId)
  │
  ├─ queueBackend present?
  │   ├─ YES: POST /api/v2/scheduler/task/{id}/cancel → Nexus
  │   │       Returns { cancelled: boolean }
  │   │
  │   └─ NO:  heap.remove(task) + store.updateStatus("completed")
  │
  └─ emit("task:cancelled") if successful


status(taskId)
  │
  └─ GET /api/v2/scheduler/task/{id} → Nexus
     Returns TaskStatus or undefined (404)
     Validates against known status values
```

### Ownership Split

```
┌─────────────────────────────────┬──────────────────────────────────┐
│         Koi Owns                │         Nexus Owns               │
├─────────────────────────────────┼──────────────────────────────────┤
│  Cron expression parsing        │  Priority queue ordering         │
│  Cron fire timing               │  5-tier priority levels          │
│  Retry count + backoff calc     │  Aging + credit-based boost      │
│  Dead-letter after max retries  │  HRRN scoring                    │
│  Task timeout enforcement       │  Fair-share admission control    │
│  Schedule pause/resume          │  Idempotency deduplication       │
│  Event emission (watch)         │  Cross-node task visibility      │
└─────────────────────────────────┴──────────────────────────────────┘
```

---

## Configuration

### `NexusTaskQueueConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `baseUrl` | `string` | (required) | Nexus Astraea base URL |
| `apiKey` | `string` | (required) | Bearer token for authentication |
| `timeoutMs` | `number` | `10_000` | HTTP request timeout |
| `fetch` | `typeof fetch` | `globalThis.fetch` | Injectable fetch for testing |

### API

| Function | Returns | Purpose |
|----------|---------|---------|
| `createNexusTaskQueue(config)` | `TaskQueueBackend` | Factory — creates the HTTP client |
| `validateNexusTaskQueueConfig(input)` | `Result<Config, KoiError>` | Validates raw config (never throws) |
| `schedulerNexusDescriptor` | `BrickDescriptor` | For manifest auto-resolution |

### Error Mapping

| HTTP Status | KoiError Code | Retryable |
|-------------|---------------|-----------|
| 401, 403 | `PERMISSION` | No |
| 404 | `NOT_FOUND` | No |
| 429 | `RATE_LIMIT` | Yes |
| 500+ | `EXTERNAL` | Yes |
| Network failure | `EXTERNAL` | Yes |
| Timeout | Propagated from `AbortSignal` | Yes |

---

## Examples

### Basic: Plug Nexus into an existing scheduler

```typescript
import { createScheduler } from "@koi/scheduler";
import { createNexusTaskQueue } from "@koi/scheduler-nexus";

const backend = createNexusTaskQueue({
  baseUrl: "https://astraea.nexus.example.com",
  apiKey: process.env.NEXUS_API_KEY!,
});

const scheduler = createScheduler(
  config, store, dispatcher, clock,
  scheduleStore,
  backend,       // optional — omit for local-only mode
);

// API is identical regardless of backend
const id = await scheduler.submit(agentId("worker"), input, "spawn", {
  priority: 1,   // Nexus will apply 5-tier + HRRN scoring
});

await scheduler.cancel(id);  // Delegates to Nexus
```

### Cron with idempotency

```typescript
// Cron tasks automatically get idempotency keys: "{scheduleId}:{fireTimestamp}"
// If the same cron fires twice at the same timestamp, Nexus deduplicates.
const schedId = await scheduler.schedule(
  "0 */5 * * *",           // every 5 minutes
  agentId("reporter"),
  { kind: "text", text: "generate-report" },
  "spawn",
);
```

### Testing with mock fetch

```typescript
import { createNexusTaskQueue } from "@koi/scheduler-nexus";

const mockFetch = async () =>
  new Response(JSON.stringify({ id: "task_123" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const queue = createNexusTaskQueue({
  baseUrl: "https://test.example.com",
  apiKey: "test-key",
  fetch: mockFetch as typeof globalThis.fetch,
});
```

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Koi owns retry, Nexus is dumb queue | Retry policy is agent-specific; centralizing it in Nexus would leak Koi semantics into the queue backend |
| Heap skipped when backend present | Nexus is sole queue — no duplication. Local heap would be stale since Nexus reorders by HRRN |
| Idempotency key = `{scheduleId}:{timestamp}` | Deterministic per cron fire. Same schedule + same fire time = same key = deduplicated |
| `TaskStore` stays local | Backend is HTTP-only for enqueue/cancel/status. Task persistence remains in SQLite for crash recovery |
| `O(n)` heap.remove() accepted | Off hot path (cancel is rare). KISS over complexity |
| Injectable fetch | Enables unit testing without network. Follows pay-nexus/registry-nexus pattern |
| `AbortSignal.timeout` for HTTP | Native Bun/Node 22+. No external timeout libraries needed |

---

## File Structure

```
packages/scheduler-nexus/
├── package.json           # deps: @koi/core, @koi/resolve
├── tsconfig.json
├── tsup.config.ts         # ESM-only, node22 target
└── src/
    ├── index.ts           # Public API exports
    ├── config.ts           # NexusTaskQueueConfig + validateNexusTaskQueueConfig()
    ├── nexus-queue.ts      # createNexusTaskQueue() — TaskQueueBackend impl
    ├── descriptor.ts       # BrickDescriptor for manifest resolution
    ├── config.test.ts      # 15 config validation tests
    └── nexus-queue.test.ts # 20 HTTP client tests
```

---

## Layer Compliance

```
L0  @koi/core ─────────┐
                        ▼
L0u @koi/resolve ──┐
                   ▼
L2  @koi/scheduler-nexus
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ never imports @koi/scheduler
```
