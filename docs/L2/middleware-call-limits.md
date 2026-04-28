# @koi/middleware-call-limits — Per-Session Tool & Model Call Caps

Two middleware factories that cap call counts per session:

- `createToolCallLimitMiddleware` — per-tool and global tool call caps (`wrapToolCall`)
- `createModelCallLimitMiddleware` — total model call cap (`wrapModelCall`)

Counters are scoped to `ctx.session.sessionId` and reset per session.

---

## Why It Exists

Bounded execution prevents runaway loops, contains cost from misbehaving agents, and gives ops a hard ceiling on per-session resource use. Without limits, a single bug or prompt injection can burn through API budget in a tight retry loop.

This middleware enforces hard caps at the middleware boundary — not at the model provider — so the cap applies regardless of which provider, fallback, or cache layer is in use.

---

## Surface

```ts
// Tool call limits — per-tool and global
export interface ToolCallLimitConfig {
  readonly limits?: Readonly<Record<string, number>>;
  readonly globalLimit?: number;
  readonly exitBehavior?: "continue" | "error"; // default "continue"
  readonly store?: CallLimitStore;
  readonly onLimitReached?: (info: LimitReachedInfo) => void;
}
export function createToolCallLimitMiddleware(config: ToolCallLimitConfig): KoiMiddleware;

// Model call limit — total per session
export interface ModelCallLimitConfig {
  readonly limit: number;
  readonly exitBehavior?: "error"; // default "error"
  readonly store?: CallLimitStore;
  readonly onLimitReached?: (info: LimitReachedInfo) => void;
}
export function createModelCallLimitMiddleware(config: ModelCallLimitConfig): KoiMiddleware;

// Validation
export function validateToolCallLimitConfig(config: unknown): Result<ToolCallLimitConfig, KoiError>;
export function validateModelCallLimitConfig(config: unknown): Result<ModelCallLimitConfig, KoiError>;
```

Phase: `intercept`. Priority: 175.

---

## Exit Behavior

### Tool

- `"continue"` (default) — return a blocked `ToolResponse` with `metadata.blocked: true`. The agent sees the block and can adapt.
- `"error"` — throw `RATE_LIMIT` KoiRuntimeError. Aborts the turn.

### Model

- `"error"` (default and only) — throw `RATE_LIMIT` KoiRuntimeError. Aborts the turn.

---

## Atomic Increment

Tool middleware uses `incrementIfBelow(key, limit)` for atomic check-and-increment. Order: global first, then per-tool. If per-tool fails, the global increment is rolled back via `decrement` so a blocked per-tool call does not consume global quota.

---

## Behavior

| Event | Outcome |
|---|---|
| Tool call, under both limits | call `next`; counters incremented |
| Tool call, hits per-tool limit, `"continue"` | blocked response; rollback global if applicable |
| Tool call, hits per-tool limit, `"error"` | throw `RATE_LIMIT`; rollback global if applicable |
| Tool call, hits global limit | blocked or throw per `exitBehavior` |
| Model call, hits limit | throw `RATE_LIMIT` |
| `onLimitReached` callback | fires once per `{sessionId,toolId}` pair |

---

## Tests (must pass)

- Per-tool limit blocks at exact threshold
- Global limit blocks at exact threshold across multiple tools
- `"continue"` returns blocked response with `metadata.blocked: true`
- `"error"` throws `KoiRuntimeError` with code `RATE_LIMIT`
- Counters reset across sessions (different `sessionId`)
- `incrementIfBelow` is atomic — concurrent calls do not exceed the limit
- Per-tool failure rolls back global increment
- `onLimitReached` fires exactly once per `{session,tool}` pair
- Validation rejects negative, non-integer, missing-required, or wrong-type fields
- Model limit aborts on Nth+1 call

---

## Out of Scope

- Token-based limits (see `@koi/middleware-token-budget`, future)
- Cost-based limits (see `@koi/middleware-pay`, future)
- Distributed counters (per-process only; future Nexus adapter)
