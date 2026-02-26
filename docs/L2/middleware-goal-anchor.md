# @koi/middleware-goal-anchor — Todo-Anchored Attention Management

`@koi/middleware-goal-anchor` is an L2 middleware package that solves the
**lost-in-the-middle problem**: in long autonomous agent runs, the model's attention
drifts away from the original objectives as the context window fills with intermediate
tool results. This middleware keeps objectives in the model's recent attention span
by injecting a live todo list as a system message at the start of every model call —
a technique pioneered by [Manus](https://manus.im).

---

## Why it exists

Long agent runs are vulnerable to **goal drift**:

```
Turn 1:  model sees objectives → perfect alignment
Turn 5:  objectives buried in middle of context → partial drift
Turn 20: objectives are distant history → model does its own thing
```

The root cause is positional attention decay. LLMs give more weight to recent tokens.
Once objectives scroll past the context midpoint, the model behaves as if the task
has changed.

This middleware solves the problem with three mechanisms:

1. **Persistent injection** — a formatted todo block is prepended to every model call as
   a `system:goal-anchor` message, placing objectives at position 0 (highest attention weight)
2. **Live status** — the block uses `- [ ]` / `- [x]` markdown checkboxes so the model
   knows which objectives are done and which remain
3. **Heuristic completion detection** — after each model response, the middleware scans the
   text for completion signals (`completed`, `finished`, `✅`, etc.) combined with objective
   keywords, and flips items to `[x]` automatically

Without this package, every agent that needs attention management must reimplement
message injection, session-scoped state, completion heuristics, and streaming support.

---

## Architecture

### Layer position

```
L0  @koi/core           ─ KoiMiddleware, TurnContext, SessionContext,
                            InboundMessage, ModelRequest, ModelResponse (types only)
L2  @koi/middleware-goal-anchor ─ this package (no L1 dependency)
```

`@koi/middleware-goal-anchor` imports only from `@koi/core`.
It never touches `@koi/engine` (L1), making it fully swappable and independently testable.

### Internal module map

```
index.ts          ← public re-exports
│
├── types.ts      ← TodoItemStatus, TodoItem, TodoState
├── config.ts     ← GoalAnchorConfig + validateGoalAnchorConfig()
├── todo.ts       ← pure functions: createTodoState, renderTodoBlock, detectCompletions
└── goal-anchor.ts ← createGoalAnchorMiddleware() factory
                      session state map + wrapModelCall/wrapModelStream/lifecycle hooks
```

### Lifecycle hook mapping

| Hook | What runs |
|---|---|
| `onSessionStart` | Initialize `TodoState` with all objectives as `"pending"` |
| `wrapModelCall` | Prepend todo block → call model → detect completions in response text |
| `wrapModelStream` | Prepend todo block → stream chunks → buffer text → detect completions in `finally` |
| `onSessionEnd` | Remove session's `TodoState` from the internal map |

### Data flow (single model call)

```
wrapModelCall(ctx, request, next)
       │
       ├─ lookup TodoState for session
       │    none? → passthrough (no-op, session not started)
       │
       ├─ renderTodoBlock(state, header) → markdown string
       │    e.g.: "## Current Objectives\n\n- [ ] search the web\n- [x] write a report"
       │
       ├─ enrichRequest: prepend InboundMessage {
       │    senderId: "system:goal-anchor",
       │    timestamp: now,
       │    content: [{ kind: "text", text: <todo block> }]
       │  }
       │
       ├─ next(enrichedRequest) → ModelResponse
       │
       ├─ detectCompletions(response.content, state)
       │    fast path: no completion pattern in text → return same state ref (no alloc)
       │    slow path: scan keywords → flip matching items to "completed"
       │
       ├─ state changed? → sessions.set(sessionId, updated)
       │                   notifyCompletions(prev, updated, onComplete)
       │
       └─ return ModelResponse
```

### Data flow (streaming model call)

```
wrapModelStream*(ctx, request, next)
       │
       ├─ lookup + enrich (same as above)
       │
       ├─ for await (chunk of next(enrichedRequest))    ─── try
       │     chunk.kind === "text_delta"? → bufferedText += chunk.delta
       │     yield chunk  ← consumer receives every chunk unmodified
       │
       └─ finally (runs even when consumer calls .return())
             detectCompletions(bufferedText, state)
             → same state update + notify path as wrapModelCall
```

> **Why `try...finally` in the stream path?**
> The engine loop exits the `for await` early (via `return()`) after processing the
> final chunk. `try...finally` guarantees completion detection always runs, regardless
> of how the consumer exits the generator.

### Todo state machine

```
createTodoState(objectives)
  → { items: [{ id: "obj-0", text: "…", status: "pending" }, …] }

         ╔═══════════════════════╗
         ║   "pending"  (initial) ║
         ╚════════════╤══════════╝
                      │
          detectCompletions(): completion keyword
          found near objective's keywords in response text
                      │
                      ▼
         ╔═══════════════════════╗
         ║  "completed" (terminal)║
         ╚═══════════════════════╝
              (never reverts)
```

State is immutable. `detectCompletions()` returns a new `TodoState` object if any
items changed, or the same reference if nothing changed (cheap equality check via
reference comparison).

---

## How it looks in a real conversation

Without `@koi/middleware-goal-anchor`:

```
[Turn 20 model context]
 ──────────────────────────────────────────────────
 [system] You are a research assistant…           ← far from model attention
 [user]   Search the web and write a report       ← objective, now distant
 [tool]   web_search result: 500 tokens           │
 [tool]   web_search result: 500 tokens           │  middle
 [tool]   file_read result: 800 tokens            │  of
 … (18 more turns of noise) …                    │  context
 [tool]   email_draft result: 200 tokens          ▼
 ──────────────────────────────────────────────────
 → model drafts second email (off-task)
```

With `@koi/middleware-goal-anchor`:

```
[Turn 20 model context — after injection]
 ──────────────────────────────────────────────────
 [system:goal-anchor]                             ← POSITION 0 (highest attention)
   ## Current Objectives
   - [x] search the web
   - [ ] write a report                           ← model sees: "still need to write"
 ──────────────────────────────────────────────────
 [system] You are a research assistant…
 [user]   Search the web and write a report
 … (previous turns) …
 ──────────────────────────────────────────────────
 → model writes the report ✓
```

---

## Completion detection heuristic

The completion scanner (`detectCompletions` in `todo.ts`) uses a two-stage filter:

### Stage 1 — Fast path: completion signal present?

```
COMPLETION_PATTERNS = [
  /\b(completed?|done|finished?|accomplished?)\b/i,
  /\[x\]/i,
  /✓|✅/,
]
```

If none of these patterns match the response text, the state is returned unchanged
(zero allocations, O(patterns) scan).

### Stage 2 — Per-item keyword check

For each `pending` item, extract keywords from the objective text:
- Split on non-word characters
- Keep words with length > 3 (filters stopwords like "the", "for", "web", "and")
- Check if any keyword appears in the response text (case-insensitive `includes`)

If a keyword matches, the item flips to `"completed"`.

```
Objective: "search the web"
Keywords:  ["search"]   ← "the" (3), "web" (3) filtered out; "search" (6) kept

Response: "I've completed the search for recent papers."
Keyword check: "search" ∈ response text? yes → mark "search the web" as complete
```

**Trade-off:** The heuristic has intentional false positives. When a model response
mentions an objective keyword alongside a completion signal, the item flips — even if
the model was describing a *previous* completion. This is acceptable because:
- The todo block is a best-effort attention aid, not a ground-truth tracker
- False positives are visible to the model on the next call (it sees `[x]`)
- For authoritative tracking, use the `onComplete` callback and track externally

---

## API

### `createGoalAnchorMiddleware(config)`

```typescript
import { createGoalAnchorMiddleware } from "@koi/middleware-goal-anchor";

const anchor = createGoalAnchorMiddleware({
  objectives: ["search the web", "write a report", "send summary email"],
  header: "## Current Task Objectives",   // optional, default: "## Current Objectives"
  onComplete: (item) => {
    console.log(`[goal-anchor] completed: "${item.text}" (id: ${item.id})`);
    // Notify external tracker, update database, etc.
  },
});
```

Returns a `KoiMiddleware` with `name: "goal-anchor"` and `priority: 340`.

When `objectives` is empty, returns a no-op middleware (passthrough for all hooks).

### `GoalAnchorConfig`

```typescript
interface GoalAnchorConfig {
  /** Task objectives. Empty array disables the middleware entirely. */
  readonly objectives: readonly string[];
  /**
   * Header line rendered above the checkbox list.
   * Default: "## Current Objectives"
   */
  readonly header?: string;
  /**
   * Called once when an objective transitions from "pending" → "completed".
   * Fires synchronously within wrapModelCall / wrapModelStream finally block.
   */
  readonly onComplete?: (item: TodoItem) => void;
}
```

### `TodoItem` and `TodoState`

```typescript
type TodoItemStatus = "pending" | "completed";

interface TodoItem {
  /** Sequential identifier: "obj-0", "obj-1", … */
  readonly id: string;
  /** Original objective text, unmodified from config. */
  readonly text: string;
  readonly status: TodoItemStatus;
}

interface TodoState {
  readonly items: readonly TodoItem[];
}
```

### `validateGoalAnchorConfig(config)`

Validates untrusted manifest options at package initialization time. Used internally
by the `@koi/starter` adapter — call it directly when constructing config from external input:

```typescript
import { validateGoalAnchorConfig } from "@koi/middleware-goal-anchor";

const result = validateGoalAnchorConfig(untrustedOptions);
if (!result.ok) {
  throw new Error(`invalid goal-anchor options: ${result.error.message}`);
}
const anchor = createGoalAnchorMiddleware(result.value);
```

Validation rules:
- `objectives` must be a non-empty array of non-empty strings (if present; empty array is valid — disables middleware)
- `header` must be a string (if present)
- `onComplete` must be a function (if present)

---

## Examples

### 1. Direct wiring with `createKoi`

```typescript
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createGoalAnchorMiddleware } from "@koi/middleware-goal-anchor";

const anchor = createGoalAnchorMiddleware({
  objectives: ["research the topic", "write a 500-word summary"],
  onComplete: (item) => console.log(`✓ ${item.text}`),
});

const koi = createKoi({
  adapter: createLoopAdapter({ ... }),
  middleware: [anchor],
});
```

### 2. Manifest-driven via `@koi/starter`

```typescript
import { createConfiguredKoi } from "@koi/starter";

const koi = await createConfiguredKoi({
  manifest: {
    name: "research-agent",
    version: "1.0.0",
    model: { name: "claude-haiku-4-5-20251001" },
    objectives: ["research the topic", "write a 500-word summary"],
    middleware: [
      {
        name: "goal-anchor",
        options: {
          header: "## My Research Tasks",
          // objectives are also read from manifest.objectives (starter merges them)
        },
      },
    ],
  },
  callbacks: {
    "goal-anchor": {
      onComplete: (item) => {
        console.log(`[goal-anchor] ✓ completed: ${item.text}`);
      },
    },
  },
});
```

### 3. Combined with `agent-monitor` for drift detection + attention management

```typescript
import { createAgentMonitorMiddleware } from "@koi/agent-monitor";
import { createGoalAnchorMiddleware } from "@koi/middleware-goal-anchor";

const OBJECTIVES = ["search the web for recent AI papers", "write a literature review"];

// Detects when tool calls drift away from objectives
const monitor = createAgentMonitorMiddleware({
  objectives: OBJECTIVES,
  goalDrift: { threshold: 1.0 },
  onAnomaly: (signal) => {
    if (signal.kind === "goal_drift") {
      console.warn(`[monitor] goal drift detected at turn ${signal.turnIndex}, score=${signal.driftScore}`);
    }
  },
});

// Keeps objectives in model's attention span
const anchor = createGoalAnchorMiddleware({
  objectives: OBJECTIVES,
  onComplete: (item) => console.log(`[anchor] ✓ ${item.text}`),
});

const koi = createKoi({
  adapter: createLoopAdapter({ ... }),
  middleware: [monitor, anchor],
});
```

The two middlewares are complementary:
- `agent-monitor` **detects** when tool calls stop matching objectives (observable signal)
- `middleware-goal-anchor` **prevents** drift by keeping objectives in the model's view

### 4. Multi-session tracking

The middleware isolates state per session. Multiple concurrent sessions are safe:

```typescript
// Same middleware instance handles concurrent sessions
const anchor = createGoalAnchorMiddleware({
  objectives: ["process the order", "send confirmation"],
});

// Session A and B run concurrently — each gets its own TodoState
const sessionA = await koi.createSession({ agentId: "order-agent" });
const sessionB = await koi.createSession({ agentId: "order-agent" });

// Completing in session A doesn't affect session B
```

---

## Rendered todo block format

Default header (`"## Current Objectives"`):

```
## Current Objectives

- [ ] search the web
- [ ] write a report
- [ ] send summary email
```

After the model completes the first two objectives:

```
## Current Objectives

- [x] search the web
- [x] write a report
- [ ] send summary email
```

The model receives this as the first message in its context window on every call.
Most instruction-following models understand `- [x]` / `- [ ]` markdown natively and
treat the list as current task state.

---

## Priority and middleware ordering

`@koi/middleware-goal-anchor` has `priority: 340`, placing it:

```
priority: 300  @koi/middleware-audit     (audit all calls)
priority: 340  @koi/middleware-goal-anchor  ← THIS (inject objectives before model sees request)
priority: 350  @koi/agent-monitor        (observe after injection)
priority: 400  @koi/middleware-permissions (enforce before execution)
```

**Why 340?** The goal anchor injects a system message into `ModelRequest.messages`.
Placing it before `agent-monitor` (350) means the monitor observes the already-enriched
request, keeping its latency and token tracking accurate. Placing it after audit (300)
ensures the audit log captures the original request before injection.

---

## Performance properties

All operations are O(objectives) per call — bounded by the number of objectives, not session length:

| Feature | Algorithm | Space |
|---|---|---|
| Session state | `Map<SessionId, TodoState>` | 1 entry per live session |
| Todo rendering | Array map + join | O(objectives) transient string |
| Completion detection (fast path) | Regex test × 3 | O(1) |
| Completion detection (slow path) | String includes × keywords | O(objectives × keywords) |
| Request enrichment | Spread + prepend | O(messages) shallow copy |
| Stream buffering | String concatenation | O(response length) per call |

Memory is bounded: each session holds one `TodoState` (array of objectives × 3 fields).
`onSessionEnd` removes the entry, so there is no accumulation across sessions.

---

## Layer compliance

```
L0  @koi/core ────────────────────────────────────────────────┐
    KoiMiddleware, TurnContext, SessionContext,                │
    InboundMessage, ModelRequest, ModelResponse,              │
    ContentBlock, TextBlock                                    │
                                                               │
                                                               ▼
L2  @koi/middleware-goal-anchor ◄──────────────────────────────┘
    imports from L0 only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external dependencies
```

**Dev-only dependencies** (`@koi/agent-monitor`, `@koi/test-utils`) are used in tests
but are not runtime imports.
