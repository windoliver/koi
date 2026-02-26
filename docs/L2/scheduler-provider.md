# @koi/scheduler-provider — Agent-Facing Scheduler Tools

An L2 `ComponentProvider` that wraps a `TaskScheduler` into 9 agent-facing tools with automatic agentId pinning. Agents can submit tasks, manage cron schedules (create/pause/resume/unschedule), query task status, view stats, and browse execution history — all scoped to their own identity.

---

## Why It Exists

Koi's `TaskScheduler` (L2 `@koi/scheduler`) is an infrastructure contract — it accepts `agentId` as an explicit parameter and exposes `watch()` for streaming events. Neither is appropriate for agent tool calls:

- Agents shouldn't know their own `agentId` — it's an infrastructure concern
- Streaming via `watch()` doesn't fit the tool call request/response model
- Raw scheduler access has no query limits, no input validation, no trust tier

`@koi/scheduler-provider` solves this by providing a `ComponentProvider` that:

- **Pins agentId** — captured at `attach()` time, agents can only see/modify their own tasks
- **Exposes 9 validated tools** — LLM-safe JSON schemas with input parsing and error handling
- **Enforces query limits** — configurable caps on `query` and `history` results
- **Attaches the SCHEDULER token** — agents can access `SchedulerComponent` via ECS

---

## What This Enables

### Before vs After

```
WITHOUT SCHEDULER-PROVIDER                   WITH SCHEDULER-PROVIDER
────────────────────────                     ───────────────────────

Agent code:                                  Agent manifest:
  "How do I schedule                           providers:
   a daily report?                               - scheduler
   I need direct access
   to TaskScheduler..."                      LLM tool call:
                                               scheduler_schedule({
  // Manual wiring                               expression: "0 9 * * *",
  const sched = getScheduler();                  input: "Generate daily report",
  const id = sched.submit(                       mode: "spawn"
    myAgentId,  ← must know ID!               })
    input,
    mode,                                    Auto-pinned:
    options,                                   ✓ agentId captured from entity
  );                                           ✓ query/history filtered to own tasks
                                               ✓ input validated before dispatch
  // Can see ALL agents' tasks                 ✓ results clamped to safe limits
  sched.query({});  ← no isolation!
```

### Self-Managing Agent Example

```
┌─────────────────────────────────────────────────────────────────┐
│                     SALES AGENT                                  │
│                                                                  │
│  "I need to check leads every morning and review                 │
│   failed tasks from yesterday."                                  │
│                                                                  │
│  Turn 1: scheduler_schedule                                      │
│    ├─ expression: "0 9 * * *"                                    │
│    ├─ input: "Check CRM for new leads and draft outreach"        │
│    └─ mode: "spawn"                                              │
│         │                                                        │
│         ▼                                                        │
│    ✓ scheduleId: "sched_170900..."                               │
│                                                                  │
│  Turn 2: scheduler_history                                       │
│    ├─ status: "failed"                                           │
│    └─ since: 1709000000000  (yesterday)                          │
│         │                                                        │
│         ▼                                                        │
│    { runs: [                                                     │
│        { taskId: "task_...", error: "CRM timeout", ... }         │
│      ],                                                          │
│      count: 1                                                    │
│    }                                                             │
│                                                                  │
│  Turn 3: scheduler_pause                                         │
│    └─ scheduleId: "sched_170900..."                              │
│         │                                                        │
│         ▼                                                        │
│    { paused: true }                                              │
│    "CRM is down, pausing until it's back."                       │
│                                                                  │
│  Turn 4: scheduler_resume                                        │
│    └─ scheduleId: "sched_170900..."                              │
│         │                                                        │
│         ▼                                                        │
│    { resumed: true }                                             │
│    "CRM is back online, resuming daily check."                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Architecture

### Layer Position

```
L0   @koi/core                  ─ TaskScheduler, SchedulerComponent, TaskRunRecord,
                                   TaskHistoryFilter, SchedulerStats, ScheduleId, TaskId
L2   @koi/scheduler             ─ createScheduler() implementation (priority queue, cron, retry)
L2   @koi/scheduler-provider    ─ this package (ComponentProvider + 9 tools)
```

Imports from `@koi/core` (L0) only. Never touches `@koi/engine` (L1) or peer L2 packages at runtime.

### Internal Module Map

```
index.ts                          ← public re-exports
│
├── constants.ts                  ← OPERATIONS, DEFAULT_PREFIX, limit constants
├── parse-args.ts                 ← safe LLM input parsing (parseString, parseEnum, etc.)
├── scheduler-component-provider.ts  ← createSchedulerProvider() factory
├── test-helpers.ts               ← createMockSchedulerComponent() for tests
│
└── tools/
    ├── submit.ts      + submit.test.ts       ← one-shot task submission
    ├── cancel.ts      + cancel.test.ts       ← cancel pending task
    ├── schedule.ts    + schedule.test.ts      ← create cron schedule
    ├── unschedule.ts  + unschedule.test.ts   ← remove cron schedule
    ├── query.ts       + query.test.ts        ← query tasks by status/priority
    ├── stats.ts       + stats.test.ts        ← scheduler statistics
    ├── pause.ts       + pause.test.ts        ← pause cron schedule
    ├── resume.ts      + resume.test.ts       ← resume cron schedule
    └── history.ts     + history.test.ts      ← task execution history
```

---

## Security Model — agentId Pinning

The core security invariant: **agents can only access their own tasks**.

```
LLM tool call:  scheduler_query({ status: "pending" })
                       │
                       ▼
               ┌───────────────────────────────────────────┐
               │  scheduler-component-provider.ts          │
               │                                           │
               │  attach(agent) {                          │
               │    // Capture agentId at assembly time     │
               │    const pinnedId = agent.pid.id;         │
               │                                           │
               │    // Component auto-injects agentId      │
               │    query: (filter) =>                     │
               │      scheduler.query({                    │
               │        ...filter,                         │
               │        agentId: pinnedId  ◄── always set  │
               │      })                                   │
               │  }                                        │
               └───────────────────────────────────────────┘
                       │
                       ▼
               TaskScheduler.query({
                 status: "pending",
                 agentId: "sales-agent"  ← injected, not from LLM
               })
```

This applies to `query`, `history`, `submit`, and `schedule` — every operation that involves an `agentId` parameter. The LLM never sees or provides the `agentId` field.

---

## The 9 Tools

| # | Tool Name | Input | Output | Description |
|---|-----------|-------|--------|-------------|
| 1 | `scheduler_submit` | `input`, `mode`, `priority?`, `delayMs?`, `maxRetries?`, `timeoutMs?` | `{ taskId }` | Submit a one-shot task |
| 2 | `scheduler_cancel` | `taskId` | `{ cancelled }` | Cancel a pending task |
| 3 | `scheduler_schedule` | `expression`, `input`, `mode`, `priority?`, `delayMs?`, `maxRetries?`, `timeoutMs?`, `timezone?` | `{ scheduleId }` | Create a recurring cron schedule |
| 4 | `scheduler_unschedule` | `scheduleId` | `{ removed }` | Remove a cron schedule permanently |
| 5 | `scheduler_query` | `status?`, `priority?`, `limit?` | `{ tasks, count }` | Query tasks (auto-filtered to own agent) |
| 6 | `scheduler_stats` | _(none)_ | `{ pending, running, completed, failed, deadLettered, activeSchedules, pausedSchedules }` | Global scheduler statistics |
| 7 | `scheduler_pause` | `scheduleId` | `{ paused }` | Pause a cron schedule (stops firing) |
| 8 | `scheduler_resume` | `scheduleId` | `{ resumed }` | Resume a paused cron schedule |
| 9 | `scheduler_history` | `status?`, `since?`, `limit?` | `{ runs, count }` | Task execution history (auto-filtered to own agent) |

### Tool Input Details

**`scheduler_submit`**
- `input` (string, required): Task prompt or JSON-encoded EngineInput
- `mode` (string, required): `"spawn"` (new agent) or `"dispatch"` (reuse current)
- `priority` (number): 0 = highest. Default: 5
- `delayMs` (number): Defer execution by N milliseconds
- `maxRetries` (number): Max retry attempts. Default: 3
- `timeoutMs` (number): Per-execution timeout in milliseconds

**`scheduler_schedule`**
- `expression` (string, required): Cron expression (e.g., `"0 9 * * *"`)
- `input` (string, required): Task prompt for each cron tick
- `mode` (string, required): `"spawn"` or `"dispatch"`
- `timezone` (string): IANA timezone (e.g., `"America/New_York"`)
- Same optional fields as `submit`

**`scheduler_history`**
- `status` (string): `"completed"` or `"failed"`
- `since` (number): Unix timestamp (ms) — only runs started after this
- `limit` (number): Max results. Default: 20, max: 50

---

## API Reference

### Factory

#### `createSchedulerProvider(config)`

Creates a `ComponentProvider` that attaches scheduler tools to agents.

```typescript
import { createSchedulerProvider } from "@koi/scheduler-provider";
```

### SchedulerProviderConfig

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `scheduler` | `TaskScheduler` | required | The scheduler backend |
| `trustTier` | `TrustTier` | `"verified"` | Trust level for all tools |
| `prefix` | `string` | `"scheduler"` | Tool name prefix (e.g., `"scheduler"` → `scheduler_submit`) |
| `operations` | `SchedulerOperation[]` | all 9 | Subset of tools to expose |
| `queryLimit` | `number` | `50` | Max results from query tool |
| `queryDefault` | `number` | `20` | Default results from query tool |
| `historyLimit` | `number` | `50` | Max results from history tool |
| `historyDefault` | `number` | `20` | Default results from history tool |

### Individual Tool Factories

For advanced usage — composing tools outside the provider:

| Factory | Creates |
|---------|---------|
| `createSubmitTool(component, prefix, trustTier)` | `scheduler_submit` |
| `createCancelTool(component, prefix, trustTier)` | `scheduler_cancel` |
| `createScheduleTool(component, prefix, trustTier)` | `scheduler_schedule` |
| `createUnscheduleTool(component, prefix, trustTier)` | `scheduler_unschedule` |
| `createQueryTool(component, prefix, trustTier, limit?, default?)` | `scheduler_query` |
| `createStatsTool(component, prefix, trustTier)` | `scheduler_stats` |
| `createPauseTool(component, prefix, trustTier)` | `scheduler_pause` |
| `createResumeTool(component, prefix, trustTier)` | `scheduler_resume` |
| `createHistoryTool(component, prefix, trustTier, limit?, default?)` | `scheduler_history` |

### L0 Types (in `@koi/core`)

```typescript
// Branded IDs
type TaskId = string & { readonly [__taskBrand]: "TaskId" };
type ScheduleId = string & { readonly [__scheduleBrand]: "ScheduleId" };

// Agent-facing component (exposed via SCHEDULER token)
interface SchedulerComponent {
  readonly submit: (input, mode, options?) => TaskId | Promise<TaskId>;
  readonly cancel: (id) => boolean | Promise<boolean>;
  readonly schedule: (expression, input, mode, options?) => ScheduleId | Promise<ScheduleId>;
  readonly unschedule: (id) => boolean | Promise<boolean>;
  readonly pause: (id) => boolean | Promise<boolean>;
  readonly resume: (id) => boolean | Promise<boolean>;
  readonly query: (filter) => readonly ScheduledTask[] | Promise<...>;
  readonly stats: () => SchedulerStats | Promise<SchedulerStats>;
  readonly history: (filter) => readonly TaskRunRecord[] | Promise<...>;
}

// Execution history record
interface TaskRunRecord {
  readonly taskId: TaskId;
  readonly agentId: AgentId;
  readonly status: "completed" | "failed";
  readonly startedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
  readonly error?: string | undefined;
  readonly result?: unknown | undefined;
  readonly retryAttempt: number;
}

// Statistics snapshot
interface SchedulerStats {
  readonly pending: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly deadLettered: number;
  readonly activeSchedules: number;
  readonly pausedSchedules: number;
}
```

---

## Examples

### 1. Wire into createKoi (standard usage)

```typescript
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createScheduler } from "@koi/scheduler";
import { createSchedulerProvider } from "@koi/scheduler-provider";

// Create scheduler with in-memory store
const scheduler = createScheduler(
  DEFAULT_SCHEDULER_CONFIG,
  myTaskStore,
  async (agentId, input, mode) => {
    // Dispatch task to engine
  },
);

// Wire as a ComponentProvider — tools auto-attach to every agent
const runtime = await createKoi({
  manifest: {
    name: "Sales Agent",
    version: "1.0.0",
    model: { name: "claude-sonnet-4-5" },
  },
  adapter: createPiAdapter({
    model: "anthropic:claude-sonnet-4-5",
    getApiKey: async () => process.env.ANTHROPIC_API_KEY!,
  }),
  providers: [
    createSchedulerProvider({ scheduler }),
  ],
});

// Agent now has 9 scheduler tools available
for await (const event of runtime.run({
  kind: "text",
  text: "Schedule a daily report at 9am EST",
})) {
  if (event.kind === "text_delta") process.stdout.write(event.delta);
}
```

### 2. Expose only subset of tools

```typescript
const provider = createSchedulerProvider({
  scheduler,
  operations: ["submit", "cancel", "query", "stats"],
  // Only 4 tools — no cron scheduling, no history
});
```

### 3. Custom tool prefix

```typescript
const provider = createSchedulerProvider({
  scheduler,
  prefix: "tasks",
  // Tools named: tasks_submit, tasks_cancel, tasks_schedule, etc.
});
```

### 4. Access SCHEDULER component from agent code

```typescript
import { SCHEDULER } from "@koi/core";
import type { SchedulerComponent } from "@koi/core";

// Inside a tool or middleware that has access to the agent entity:
const sched = agent.components.get(SCHEDULER) as SchedulerComponent;

// Programmatic access — same pinned agentId as tools
const taskId = await sched.submit(
  { kind: "text", text: "Process order #123" },
  "dispatch",
);

const history = await sched.history({ status: "failed", limit: 10 });
```

### 5. Custom query/history limits

```typescript
const provider = createSchedulerProvider({
  scheduler,
  queryLimit: 100,     // Allow up to 100 results from query
  queryDefault: 25,    // Return 25 by default
  historyLimit: 200,   // Allow up to 200 history records
  historyDefault: 50,  // Return 50 by default
});
```

---

## What the Provider Attaches

```
createSchedulerProvider({ scheduler })
  │
  │  attach(agent)
  ▼
┌─────────────────────────────────────────────────────────┐
│  Agent entity receives:                                  │
│                                                          │
│  SCHEDULER token ──────► SchedulerComponent              │
│    (for programmatic access)    │                        │
│                                 │ pinned to agent.pid.id │
│                                 ▼                        │
│  tool:scheduler_submit ──► Tool { descriptor, execute }  │
│  tool:scheduler_cancel ──► Tool { descriptor, execute }  │
│  tool:scheduler_schedule ► Tool { descriptor, execute }  │
│  tool:scheduler_unschedule Tool { descriptor, execute }  │
│  tool:scheduler_query ───► Tool { descriptor, execute }  │
│  tool:scheduler_stats ───► Tool { descriptor, execute }  │
│  tool:scheduler_pause ───► Tool { descriptor, execute }  │
│  tool:scheduler_resume ──► Tool { descriptor, execute }  │
│  tool:scheduler_history ─► Tool { descriptor, execute }  │
│                                                          │
│  Total: 1 component + 9 tools = 10 entries               │
└─────────────────────────────────────────────────────────┘
```

---

## Layer Compliance

```
L0  @koi/core ────────────────────────────────────────────┐
    TaskScheduler, SchedulerComponent, ScheduledTask,      │
    SchedulerStats, TaskRunRecord, TaskHistoryFilter,       │
    TaskId, ScheduleId, AgentId, Tool, TrustTier,          │
    ComponentProvider, Agent, SCHEDULER — types + tokens    │
                                                           ▼
L2  @koi/scheduler-provider ◄─────────────────────────────┘
    imports from L0 only
    ✗ never imports @koi/engine (L1)
    ✗ never imports @koi/scheduler or peer L2 packages
    ✓ zero external dependencies
```

**Dev-only:** `@koi/scheduler`, `@koi/engine`, `@koi/engine-pi`, `@koi/test-utils` used in integration/E2E tests but not runtime imports.

---

## Testing

### Unit tests (66 total)

```bash
bun test packages/scheduler-provider/
```

9 describe blocks (one per tool) + provider integration + security:

| Block | Tests |
|-------|-------|
| `submit.test.ts` | Happy path, mode validation, optional params, error handling |
| `cancel.test.ts` | Happy path, missing taskId, backend error |
| `schedule.test.ts` | Happy path, cron expression, timezone, optional params |
| `unschedule.test.ts` | Happy path, missing scheduleId, backend error |
| `query.test.ts` | Happy path, filters, limit clamping |
| `stats.test.ts` | Happy path, all counters, backend error |
| `pause.test.ts` | Happy path, branded ID passthrough, missing scheduleId, backend error |
| `resume.test.ts` | Happy path, branded ID passthrough, missing scheduleId, backend error |
| `history.test.ts` | Happy path, status filter, since filter, limit clamping (max+min), default limit, invalid status, backend error |

### Integration tests

| File | Tests |
|------|-------|
| `provider.test.ts` | Attaches 10 entries (1 component + 9 tools), correct tool names, detach no-op |
| `security.test.ts` | agentId pinning for query, history; no agentId in any tool schema |

### E2E tests (8 tests, real Anthropic API)

```bash
E2E_TESTS=1 bun test packages/engine/src/__tests__/e2e-scheduler.test.ts
```

| # | Test | What it proves |
|---|------|----------------|
| 1 | LLM calls `scheduler_stats` | Tool advertisement + LLM selection + pausedSchedules visible |
| 2 | LLM calls `scheduler_pause` | Correct scheduleId passthrough |
| 3 | LLM calls `scheduler_resume` | Correct scheduleId passthrough |
| 4 | LLM calls `scheduler_history` | History retrieval + failure summarization |
| 5 | Middleware fires for scheduler tools | `wrapToolCall` interposition works |
| 6 | Multi-tool sequence | schedule + pause + resume + history in one agent turn |
| 7 | SCHEDULER token access | Real scheduler via ECS component token |
| 8 | Real scheduler round-trip | schedule + pause + verify + resume + verify + history |
