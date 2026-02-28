# @koi/middleware-goal-reminder — Adaptive Periodic Goal Injection

`@koi/middleware-goal-reminder` is an L2 middleware package that solves the
**goal drift problem with minimal token overhead**: instead of injecting goals on
every model call (like `@koi/middleware-goal-anchor`), it uses adaptive intervals
that stretch when the agent is on-track and tighten when drift is detected.
Inspired by Claude Code's every-5-turn system reminders.

---

## Why it exists

`@koi/middleware-goal-anchor` injects on **every** model call. That works but costs
tokens — for a 30-turn session with a 500-token todo block, that's 15,000 extra tokens.
Most of those injections are unnecessary because the agent is already on-task.

```
goal-anchor:   ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓ ▓   (every call — 15 injections)
goal-reminder: ▓ · · · ▓ · · · · · · · · · ▓   (adaptive  — 3 injections)

▓ = inject    · = passthrough
```

Goal-reminder saves 80%+ tokens in typical sessions by only injecting when needed,
while still catching drift and tightening injection frequency when the agent wanders.

---

## Architecture

### Layer position

```
L0  @koi/core                    ─ KoiMiddleware, TurnContext, SessionContext,
                                     InboundMessage, ModelRequest, ModelResponse (types only)
L2  @koi/middleware-goal-reminder ─ this package (no L1 dependency)
```

`@koi/middleware-goal-reminder` imports only from `@koi/core`.
It never touches `@koi/engine` (L1), making it fully swappable and independently testable.

### Internal module map

```
index.ts              ← public re-exports
│
├── types.ts          ← ReminderSource (discriminated union), ReminderSessionState
├── config.ts         ← GoalReminderConfig + validateGoalReminderConfig()
├── interval.ts       ← computeNextInterval (pure), defaultIsDrifting (pure)
├── sources.ts        ← resolveAllSources (async, parallel, fail-safe)
├── goal-extractor.ts ← createGoalExtractorSource (LLM-based goal extraction with caching)
└── goal-reminder.ts  ← createGoalReminderMiddleware() factory
                         session state map + lifecycle hooks + injection logic
```

### Lifecycle hook mapping

| Hook | What runs |
|---|---|
| `onSessionStart` | Initialize `ReminderSessionState` with turn counter at 0 |
| `onBeforeTurn` | Increment turn counter, check trigger condition, run drift detection on trigger turns |
| `wrapModelCall` | If `shouldInject`: resolve sources → prepend reminder message → call model |
| `wrapModelStream` | Same as `wrapModelCall` but for streaming responses |
| `onSessionEnd` | Remove session state from the internal map |

---

## How it works

### The decision flow (every turn)

```
onBeforeTurn
│
├─ turnCount - lastReminderTurn < currentInterval?
│  └─ YES → shouldInject = false (not time yet, passthrough)
│
└─ NO → trigger turn reached
   │
   ├─ Run isDrifting check:
   │  ├─ Default: keyword match (last 3 messages vs goal keywords, zero API calls)
   │  └─ Custom: user-supplied callback (could use LLM, embeddings, anything)
   │
   ├─ shouldInject = true (ALWAYS inject on trigger turns)
   │
   └─ Compute NEXT interval:
      ├─ Drifting  → reset to baseInterval (inject more often)
      └─ On-track  → double interval, cap at maxInterval (inject less)
```

Key: **every trigger turn injects**. The drift result only controls how far away
the *next* injection will be.

### Adaptive interval progression

```
Interval
 20 ┤                          ┌─────────────────── max cap
    │                          │
    │              ┌───────────┘
 10 ┤     ┌────────┘                  ┌───────────
    │     │                           │
  5 ┤─────┘                    ───────┘
    │  base                   ↑ drift detected!
    │                         │ reset to base
  1 ┤                         │
    └──────────────────────────────────────────── Turns
       5    10    20    20    5    10    20

On-track: interval doubles   5 → 10 → 20 → 20 (capped)
Drifting:  interval resets   20 → 5 (back to base)
```

### Default drift detection

No LLM needed. Pure keyword matching against the last 3 messages:

```
Goals configured: ["Refactor authentication module"]
Keywords extracted (≥4 chars): {"refactor", "authentication", "module"}

Last 3 messages contain "authentication"?
  YES → on-track (not drifting) → double interval
  NO  → drifting → reset to base interval
```

Fail-safe behavior:
- Empty goals → never drifting
- Empty messages → drifting
- Custom `isDrifting` throws → treated as drifting (inject more often)

---

## Source kinds

Reminder content comes from a `sources` array — a discriminated union with 4 kinds:

| Kind | Resolved at | XML tag | Use case |
|---|---|---|---|
| `manifest` | config time | `<goals>` | Static objectives from agent manifest |
| `static` | config time | `<context>` | Fixed constraints, style guidelines |
| `dynamic` | injection time | `<context>` | Live context derived from conversation |
| `tasks` | injection time | `<tasks>` | Active task list from tracker |

`dynamic.fetch(ctx)` and `tasks.provider(ctx)` receive `TurnContext`, so they can
derive content from the live conversation — no external state needed.

### Injected message format

```
role: "system"
name: "goal-reminder"

## Reminder

<reminder>
  <goals>
    - Refactor the auth module
    - Write unit tests
  </goals>
  <context>
    Current sprint: v2.1 release
  </context>
  <tasks>
    - Fix login bug
    - Update docs
  </tasks>
</reminder>
```

---

## Goal extraction from conversation

For agents with dynamic goals (the user's request IS the goal), use
`createGoalExtractorSource` — a factory that wraps an LLM call with per-session
caching to keep costs low.

### The problem

Static objectives work for single-purpose agents. But for general assistants,
the goal changes mid-conversation:

```
Turn 1:  "Refactor auth module"        ← goal
Turn 12: "Actually fix the payment bug" ← goal changed
Turn 18: "Ok back to auth"              ← goal changed again
```

Only an LLM can reliably extract the current goal from conversation history.

### The solution

```
createGoalExtractorSource({
  summarize: (messages) → LLM call → "current goal string",
  extractEvery: 3,     // re-extract every 3rd injection
})
```

With `baseInterval=5` and `extractEvery=3`, the LLM is called every 15 turns:

```
Injection turns:   5     10     15     20     25     30
LLM extract:       ✓      ·      ·      ✓      ·      ·   (extractEvery=3)
Cache used:        ·      ✓      ✓      ·      ✓      ✓

2 LLM calls in 30 turns. Cheap.
```

Fail-safe: if the LLM call fails, the cached goal is returned. If no cache exists,
a placeholder is emitted.

---

## Comparison with goal-anchor

| Aspect | goal-anchor | goal-reminder |
|---|---|---|
| Injection frequency | Every model call | Adaptive (every N turns) |
| Token cost | High (15,000+ in 30 turns) | Low (~3 injections) |
| Goal format | Markdown checkboxes `[x]/[ ]` | XML-tagged `<reminder>` block |
| Completion tracking | Yes (heuristic `[x]` detection) | No |
| Drift detection | No | Yes (keyword-based + pluggable) |
| Dynamic goals | No (static objectives only) | Yes (via `dynamic` source + extractor) |
| LLM calls for goals | 0 | 0 (static) or ~2/session (extractor) |
| Priority | 340 | 330 (runs before anchor) |
| Best for | Task completion tracking | Long sessions, token-sensitive |

The two middlewares are **complementary**, not competing:
- Use **goal-anchor** when you need completion tracking (`[x]` detection)
- Use **goal-reminder** when you need token efficiency with drift detection
- Use **both** together: reminder handles drift, anchor tracks completions

---

## API

### `createGoalReminderMiddleware(config)`

```typescript
import { createGoalReminderMiddleware } from "@koi/middleware-goal-reminder";

const reminder = createGoalReminderMiddleware({
  sources: [
    { kind: "manifest", objectives: ["search the web", "write report"] },
    { kind: "static", text: "Always use TypeScript strict mode" },
  ],
  baseInterval: 5,
  maxInterval: 20,
});
```

Returns a `KoiMiddleware` with `name: "goal-reminder"` and `priority: 330`.

### `GoalReminderConfig`

```typescript
interface GoalReminderConfig {
  /** Sources of reminder content. Must be non-empty. */
  readonly sources: readonly ReminderSource[];
  /** Base interval between reminders in turns. Must be >= 1. Default: 5. */
  readonly baseInterval: number;
  /** Maximum interval. Must be >= baseInterval. Default: 20. */
  readonly maxInterval: number;
  /** Custom drift detector. Defaults to keyword-based detection. */
  readonly isDrifting?: (ctx: TurnContext) => boolean | Promise<boolean>;
  /** Header text. Default: "Reminder". */
  readonly header?: string;
}
```

### `ReminderSource`

```typescript
type ReminderSource =
  | { readonly kind: "manifest"; readonly objectives: readonly string[] }
  | { readonly kind: "static"; readonly text: string }
  | { readonly kind: "dynamic"; readonly fetch: (ctx: TurnContext) => string | Promise<string> }
  | { readonly kind: "tasks"; readonly provider: (ctx: TurnContext) => readonly string[] | Promise<readonly string[]> };
```

### `createGoalExtractorSource(config)`

```typescript
import { createGoalExtractorSource } from "@koi/middleware-goal-reminder";

const { source, clearSession } = createGoalExtractorSource({
  summarize: async (messages) => {
    return await cheapLLM("What is the user's current goal?", messages);
  },
  extractEvery: 3,
});
```

Returns `{ source: ReminderSource, clearSession: (sessionId: string) => void }`.

### `GoalExtractorConfig`

```typescript
interface GoalExtractorConfig {
  /** Summarize current goal from messages. Typically a cheap LLM call. */
  readonly summarize: (messages: readonly InboundMessage[]) => string | Promise<string>;
  /** Re-extract every N injections. Default: 1 (every injection). */
  readonly extractEvery?: number;
}
```

### Pure utility functions

| Function | Signature | Purpose |
|---|---|---|
| `computeNextInterval` | `(state, isDrifting, base, max) → ReminderSessionState` | Pure interval computation |
| `defaultIsDrifting` | `(messages, goals) → boolean` | Keyword-based drift detection |
| `resolveAllSources` | `(sources, ctx) → Promise<string>` | Parallel source resolution |
| `validateGoalReminderConfig` | `(config) → Result<GoalReminderConfig, KoiError>` | Config validation |

---

## Examples

### 1. Static goals — single-purpose agent

```typescript
const reminder = createGoalReminderMiddleware({
  sources: [
    { kind: "manifest", objectives: ["Review code quality", "Check security"] },
  ],
  baseInterval: 5,
  maxInterval: 20,
});

const koi = await createKoi({
  adapter: createLoopAdapter({ modelCall, maxTurns: 30 }),
  middleware: [reminder],
});
```

### 2. Dynamic goals — derive from conversation

```typescript
const reminder = createGoalReminderMiddleware({
  sources: [{
    kind: "dynamic",
    fetch: (ctx) => {
      // Use the first user message as the goal
      const first = ctx.messages[0];
      const text = first?.content.find(b => b.kind === "text");
      return `Current task: ${text?.kind === "text" ? text.text : "unknown"}`;
    },
  }],
  baseInterval: 5,
  maxInterval: 20,
});
```

### 3. LLM-extracted goals with caching

```typescript
const { source, clearSession } = createGoalExtractorSource({
  summarize: async (messages) => {
    return await haiku("Summarize the current goal in one sentence.", messages);
  },
  extractEvery: 3, // LLM called every 3rd injection
});

const reminder = createGoalReminderMiddleware({
  sources: [source],
  baseInterval: 5,
  maxInterval: 20,
});
```

### 4. Combined with goal-anchor

```typescript
const reminder = createGoalReminderMiddleware({
  sources: [{ kind: "manifest", objectives: OBJECTIVES }],
  baseInterval: 5,
  maxInterval: 20,
});

const anchor = createGoalAnchorMiddleware({
  objectives: OBJECTIVES,
  onComplete: (item) => console.log(`completed: ${item.text}`),
});

const koi = await createKoi({
  adapter: createLoopAdapter({ modelCall, maxTurns: 50 }),
  middleware: [reminder, anchor], // reminder at 330, anchor at 340
});
```

### 5. Custom drift detection

```typescript
const reminder = createGoalReminderMiddleware({
  sources: [{ kind: "manifest", objectives: ["Build payment system"] }],
  baseInterval: 5,
  maxInterval: 20,
  isDrifting: (ctx) => {
    // Custom: check if the last tool call was related to payments
    const lastToolResult = ctx.messages.findLast(m =>
      m.senderId.startsWith("tool:")
    );
    return !lastToolResult?.content.some(
      b => b.kind === "text" && b.text.includes("payment")
    );
  },
});
```

---

## Priority and middleware ordering

`@koi/middleware-goal-reminder` has `priority: 330`, placing it:

```
priority: 300  @koi/middleware-audit         (audit all calls)
priority: 330  @koi/middleware-goal-reminder  ← THIS (inject reminders before anchor)
priority: 340  @koi/middleware-goal-anchor    (inject todo before model sees request)
priority: 350  @koi/agent-monitor            (observe after injection)
priority: 400  @koi/middleware-permissions    (enforce before execution)
```

**Why 330?** Runs before goal-anchor so both injections are visible. The reminder
is a periodic reinforcement; the anchor is a continuous one.

---

## Performance properties

| Feature | Algorithm | Per-turn cost |
|---|---|---|
| Turn counting | Integer increment | O(1) |
| Trigger check | Integer subtraction | O(1) |
| Drift detection (default) | Keyword ∈ last 3 messages | O(keywords × message length) |
| Source resolution | `Promise.all` parallel | O(sources) |
| Request enrichment | Spread + prepend | O(messages) shallow copy |
| Goal extraction (extractor) | Cached LLM call | 0 on cache hit, 1 LLM call on miss |

Memory: one `ReminderSessionState` per live session (4 numbers). Cleaned up on `onSessionEnd`.

---

## Layer compliance

```
L0  @koi/core ────────────────────────────────────────────────┐
    KoiMiddleware, TurnContext, SessionContext,                │
    InboundMessage, ModelRequest, ModelResponse                │
                                                               │
                                                               ▼
L2  @koi/middleware-goal-reminder ◄──────────────────────────┘
    imports from L0 only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external runtime dependencies
```

**Dev-only dependencies** (`@koi/engine`, `@koi/engine-loop`, `@koi/model-router`,
`@koi/test-utils`) are used in E2E tests but are not runtime imports.

---

## Related

- [Issue #505](https://github.com/windoliver/koi/issues/505) — Original feature request
- [Issue #507](https://github.com/windoliver/koi/issues/507) — L0u classification update (shipped together)
- [Issue #562](https://github.com/windoliver/koi/issues/562) — `@koi/middleware-memory-recall` (complementary: proactive memory injection)
- `docs/L2/middleware-goal-anchor.md` — Complementary every-call injection middleware
