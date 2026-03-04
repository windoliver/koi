# @koi/middleware-conversation — Thread History Continuity

Links stateless channel sessions via `threadId` — loads history on session start, injects it into model calls within a token budget, and persists new turns on session end. Pluggable via the L0 `ThreadStore` interface.

---

## Why It Exists

Channel adapters (Telegram, Slack, Discord) are stateless: each incoming message triggers a fresh `runtime.run()` with no conversation memory. Without this middleware, every session starts from scratch — the agent has no idea what the user said 30 seconds ago.

This middleware solves three problems:

1. **Conversation continuity** — the agent sees prior turns when responding, enabling multi-turn dialogue
2. **Token budget management** — history is trimmed to fit within a configurable token budget (newest messages prioritized)
3. **Automatic persistence** — new turns are persisted to the thread store on session end, no manual bookkeeping

Without this package, every channel adapter would reimplement history loading, injection, pruning, and persistence logic.

---

## Architecture

`@koi/middleware-conversation` is an **L2 feature package** — it depends only on L0 (`@koi/core`) and L0u utilities (`@koi/token-estimator`). Zero external dependencies.

```
┌──────────────────────────────────────────────────────────────┐
│  @koi/middleware-conversation  (L2)                           │
│                                                               │
│  conversation-middleware.ts  ← middleware factory (core logic) │
│  config.ts                   ← ConversationConfig + defaults  │
│  map-thread-to-inbound.ts    ← ThreadMessage → InboundMessage │
│  prune-history.ts            ← truncation + optional compact  │
│  index.ts                    ← public API surface             │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│  Dependencies                                                 │
│                                                               │
│  @koi/core            (L0)   KoiMiddleware, ThreadStore,      │
│                               ThreadMessage, SessionContext,   │
│                               ModelRequest, InboundMessage     │
│  @koi/token-estimator  (L0u)  estimateTokens (chars/4)        │
└───────────────────────────────────────────────────────────────┘
```

---

## How It Works

### Session Lifecycle Flow

```
  Channel message arrives (e.g., Telegram webhook)
       │
       ▼
  ┌──────────────────┐
  │ onSessionStart() │  ← resolve threadId, load history from ThreadStore
  │                  │     pre-compute token estimates per message
  └──────┬───────────┘
         │
         ▼
  ┌──────────────────┐     no history?     ┌─────────────────┐
  │ wrapModelCall()  │──── passthrough ───▶│ next(request)   │
  │ wrapModelStream()│                      └─────────────────┘
  │                  │     has history?
  │ injectHistory()  │──── prepend selected history messages
  │ captureNewMsgs() │     capture user + assistant messages
  └──────┬───────────┘
         │
         ▼
  ┌──────────────────┐
  │ onSessionEnd()   │  ← prune combined history, persist via
  │                  │     store.appendAndCheckpoint()
  │                  │     per-thread mutex serializes writes
  └──────────────────┘
```

1. **Load**: `onSessionStart` resolves a thread ID from `config.resolveThreadId(ctx)`, `ctx.metadata.threadId`, or `ctx.channelId`. Loads up to `maxMessages` from the `ThreadStore` and pre-computes token estimates.

2. **Inject**: `wrapModelCall` / `wrapModelStream` prepend selected history messages to the model request. A backwards walk through token estimates selects as many recent messages as fit within `maxHistoryTokens`. The newest message is always included even if it exceeds the budget.

3. **Capture**: New user messages (those without `fromHistory` metadata) and assistant responses are recorded during model calls.

4. **Persist**: `onSessionEnd` combines loaded history with new messages, runs `pruneHistory()` (truncation or custom compaction), and persists via `store.appendAndCheckpoint()`. A per-thread promise-chain mutex serializes concurrent writes.

### Thread ID Resolution

```
resolveThreadId(ctx)  →  ctx.metadata.threadId  →  ctx.channelId
     (custom)               (channel-provided)        (fallback)
```

The first non-undefined value wins. If none resolve, no history is loaded or persisted.

### Token Budget Selection

```
Messages: [m1, m2, m3, m4, m5]  (oldest → newest)
Budget: 100 tokens

Walk backwards from m5:
  m5: 30 tokens → budget=70, include
  m4: 25 tokens → budget=45, include
  m3: 40 tokens → budget=5, include
  m2: 50 tokens → budget=-45, STOP (already have messages)

Selected: [m3, m4, m5] → prepended to model request
```

---

## API Reference

### `createConversationMiddleware(config)`

Creates a KoiMiddleware that loads, injects, and persists conversation history.

```typescript
import { createConversationMiddleware } from "@koi/middleware-conversation";

const middleware = createConversationMiddleware({
  store: threadStore,
  maxHistoryTokens: 4096,
  maxMessages: 200,
});
```

### `ConversationConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `store` | `ThreadStore` | required | Persistence backend for thread messages |
| `maxHistoryTokens` | `number` | `4096` | Maximum tokens of history to inject |
| `maxMessages` | `number` | `200` | Maximum messages to load from store |
| `estimateTokens` | `(text: string) => number` | `chars / 4` | Custom token estimator |
| `resolveThreadId` | `(ctx: SessionContext) => string \| undefined` | - | Custom thread ID resolver |
| `compact` | `(msgs: readonly ThreadMessage[]) => readonly ThreadMessage[]` | - | Custom compaction strategy |

### `CONVERSATION_DEFAULTS`

```typescript
{
  maxHistoryTokens: 4096,
  maxMessages: 200,
}
```

---

## Examples

### 1. Basic usage with in-memory store

```typescript
import { createInMemorySnapshotChainStore, createThreadStore } from "@koi/snapshot-chain-store";
import { createConversationMiddleware } from "@koi/middleware-conversation";

const chainStore = createInMemorySnapshotChainStore();
const threadStore = createThreadStore({ store: chainStore });

const middleware = createConversationMiddleware({
  store: threadStore,
});
// Pass to createKoi({ middleware: [middleware], ... })
```

### 2. Custom token budget and message limit

```typescript
const middleware = createConversationMiddleware({
  store: threadStore,
  maxHistoryTokens: 8192,  // larger context window
  maxMessages: 500,         // keep more history
});
```

### 3. Custom thread ID resolver (e.g., per-user threads)

```typescript
const middleware = createConversationMiddleware({
  store: threadStore,
  resolveThreadId: (ctx) => {
    // Unique thread per user+channel combination
    return `${ctx.channelId}-${ctx.userId}`;
  },
});
```

### 4. With custom compaction

```typescript
const middleware = createConversationMiddleware({
  store: threadStore,
  compact: (messages) => {
    // Keep system messages + last 50 turns
    const system = messages.filter((m) => m.role === "system");
    const recent = messages.filter((m) => m.role !== "system").slice(-50);
    return [...system, ...recent];
  },
});
```

---

## What This Enables

**Multi-turn conversations over stateless channels.** Without this middleware, a Telegram bot forgets everything after each message. With it:

- A user says "My name is Alice" in message 1
- The user asks "What's my name?" in message 2 (separate `runtime.run()`)
- The agent sees both turns and correctly responds "Alice"

This is the same pattern used by production agent frameworks — each incoming message triggers a fresh execution, and a thread ID connects them into a coherent conversation. The middleware handles the plumbing so channel adapters stay stateless and simple.

---

## Middleware Properties

| Property | Value |
|----------|-------|
| `name` | `"koi:conversation"` |
| `priority` | `100` |
| `phase` | `"resolve"` |
| Hooks implemented | `onSessionStart`, `wrapModelCall`, `wrapModelStream`, `onSessionEnd`, `describeCapabilities` |

**Priority 100, phase "resolve"** means conversation history is loaded and injected early in the middleware chain, before other middleware that may depend on the full message context.

---

## Safety Properties

- **Newest-always**: Even if the token budget is zero, the newest history message is always injected to prevent total amnesia
- **Fail-open on load errors**: If `store.listMessages()` fails, the session continues without history rather than crashing
- **Fail-loud on write errors**: If `store.appendAndCheckpoint()` fails, an error is thrown with cause chaining
- **Write serialization**: A per-thread promise-chain mutex prevents interleaved writes from concurrent sessions on the same thread
- **No double-fetch**: History loaded in `onSessionStart` is cached and reused in `onSessionEnd` for pruning

---

## Testing

```bash
bun test packages/mm/middleware-conversation/src/
```

| File | Tests | Focus |
|------|-------|-------|
| `map-thread-to-inbound.test.ts` | 9 | Role mapping, TextBlock wrapping, fromHistory flag |
| `prune-history.test.ts` | 7 | Truncation, compact callback, edge cases |
| `conversation-middleware.test.ts` | 15 | Token budget, session lifecycle, thread ID resolution, capabilities |
| `__tests__/api-surface.test.ts` | 10 | Name, priority, phase, hook presence, defaults |
| `__tests__/multi-run.test.ts` | 2 | 3-session accumulation, chronological order |
| `__tests__/concurrency.test.ts` | 1 | 3 concurrent onSessionEnd calls serialized by mutex |

**Total: 44 tests, 98.4% line coverage, 100% function coverage.**

---

## Layer Compliance

```
L0  @koi/core ── ThreadStore, KoiMiddleware, SessionContext ──────┐
L0u @koi/token-estimator ── estimateTokens ───────────────────────┤
                                                                   ▼
L2  @koi/middleware-conversation ◄─────────────────────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
```
