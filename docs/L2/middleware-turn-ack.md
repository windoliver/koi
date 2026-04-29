# @koi/middleware-turn-ack — Two-Stage Turn Acknowledgement

`@koi/middleware-turn-ack` is an L2 middleware that surfaces turn-status to the user channel. It debounces a "processing" signal (so fast turns stay silent) and emits an "idle" signal when the turn finishes. Optionally annotates each tool invocation.

This middleware is purely observational from the agent's perspective — it never modifies requests, responses, or stop conditions.

---

## Why It Exists

Long-running turns (multi-tool, large model, slow network) leave channels visually frozen. A debounced status update tells the user "the agent is still working" without polluting the transcript for sub-second turns.

```
Without turn-ack:
  user sends → … 8s of silence … → assistant message arrives

With turn-ack (debounce 100ms):
  user sends → 100ms → "processing" status → … work … → "idle" status + assistant message
  fast turns (<100ms): no status flicker
```

---

## Architecture

### Layer Position

```
L0  @koi/core                        ─ KoiMiddleware, ChannelStatus, TurnContext
L2  @koi/middleware-turn-ack         ─ this package (no L1, no peer L2)
```

No L0u dependencies.

### Internal Module Map

```
index.ts          ← public re-exports
└── turn-ack.ts   ← createTurnAckMiddleware() factory + scheduler injection
```

### Middleware Priority

```
 50 ─ reflex             (intercept)
 50 ─ turn-ack           (resolve, this package)
150 ─ prompt-cache       (resolve)
200 ─ turn-prelude       (resolve)
```

Tier ordering: `intercept` → `resolve` → `observe`. Within `resolve`, lower priority runs first. Turn-ack at priority 50 enters the onion early so its `onBeforeTurn` schedule fires before request mutators take effect, and its `onAfterTurn` cleanup runs last.

---

## How It Works

### Turn Lifecycle

```
onBeforeTurn(ctx)
  ├─ ctx.sendStatus undefined? ──► no-op
  ├─ Cancel any prior debounce timer for this session
  ├─ Schedule setTimeout(debounceMs):
  │     fire-and-forget ctx.sendStatus({ kind: "processing", turnIndex })
  │
  └─ Save AbortController in per-session map

onAfterTurn(ctx)
  ├─ Abort pending timer (skips "processing" if turn was fast)
  ├─ Delete from session map
  └─ fire-and-forget ctx.sendStatus({ kind: "idle", turnIndex })

wrapToolCall(ctx, request, next)
  ├─ toolStatus disabled? ──► next(request)
  └─ fire-and-forget ctx.sendStatus({
        kind: "processing",
        turnIndex,
        detail: `calling ${request.toolId}`,
      })
      ─► next(request)

onSessionEnd(ctx)
  └─ Cleanup: abort any in-flight timer
```

`sendStatus` calls are always fire-and-forget. A rejected promise is swallowed via the configured `onError` and never propagates up the agent loop.

### Scheduler Injection (test ergonomics)

The factory accepts an optional `scheduler: { setTimeout, clearTimeout }` so tests can advance time deterministically without `Bun.sleep()`. Defaults to globals.

---

## API Reference

### `createTurnAckMiddleware(config?)`

```typescript
import { createTurnAckMiddleware } from "@koi/middleware-turn-ack";

const turnAck = createTurnAckMiddleware({
  debounceMs: 150,
  toolStatus: true,
});
```

Returns `KoiMiddleware` with:
- `name`: `"turn-ack"`
- `priority`: `50`
- `phase`: `"resolve"`
- `onBeforeTurn`, `onAfterTurn`, `onSessionEnd`, `wrapToolCall`, `describeCapabilities`

### `TurnAckConfig`

```typescript
interface TurnAckConfig {
  /** Debounce window before "processing" fires. Default: 100ms. */
  readonly debounceMs?: number;
  /** Emit per-tool processing status from wrapToolCall. Default: true. */
  readonly toolStatus?: boolean;
  /** Callback for swallowed sendStatus rejections. Default: console.warn. */
  readonly onError?: (e: unknown) => void;
  /** Scheduler injection for deterministic tests. Default: globals. */
  readonly scheduler?: {
    readonly setTimeout: typeof setTimeout;
    readonly clearTimeout: typeof clearTimeout;
  };
}
```

---

## Layer Compliance

```
@koi/middleware-turn-ack imports:
  ✅ @koi/core      (L0)  — KoiMiddleware, ChannelStatus, TurnContext, ToolHandler
  ❌ @koi/engine     (L1)  — NOT imported
  ❌ peer L2          —      NOT imported
```

Marked `koi.optional: true`. Channels that do not implement `sendStatus` cause turn-ack to no-op transparently.
