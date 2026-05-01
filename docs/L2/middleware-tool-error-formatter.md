# @koi/middleware-tool-error-formatter — Actionable Tool Error Feedback

Catches errors thrown by tool handlers and converts them into structured `ToolResponse` messages the model can read, instead of letting the throw propagate up the engine loop.

---

## Why It Exists

When a tool throws, the agent loop has two bad options without this middleware:

1. **Propagate the throw** — kills the turn; the model never sees what went wrong and can't recover.
2. **Swallow silently** — model gets no feedback and re-invokes the failing tool.

Models recover much better from a *visible, actionable* error string than from a missing response. This middleware converts thrown errors into model-readable output, while preserving the raw failure metadata for downstream observers (audit, telemetry).

It also acts as a **secret-redaction boundary** — error messages from tools often contain auth tokens, API keys, or other secrets that must not be leaked into the model transcript or logs.

---

## Architecture

L2 feature package. Depends only on `@koi/core` (L0) and `@koi/errors` (L0u).

```
┌────────────────────────────────────────────────────────┐
│  @koi/middleware-tool-error-formatter  (L2)            │
│                                                        │
│  types.ts                ← formatter + config types    │
│  formatter-middleware.ts ← middleware factory          │
│  index.ts                ← public API                  │
├────────────────────────────────────────────────────────┤
│  Dependencies                                          │
│  @koi/core    (L0)   KoiMiddleware, ToolRequest,       │
│                       ToolResponse, ToolHandler,        │
│                       TurnContext, CapabilityFragment,  │
│                       KoiError, JsonObject              │
│  @koi/errors  (L0u)  formatToolError, isKoiError,      │
│                       toKoiError                        │
└────────────────────────────────────────────────────────┘
```

---

## How It Works

The middleware wraps every tool call via `wrapToolCall`. On the success path it is a no-op pass-through. On the failure path it catches the throw, runs the formatter pipeline, and returns a `ToolResponse` with `metadata.error = true`.

```
ToolRequest
   │
   ▼
 next(request)  ──── success ────▶ ToolResponse (passthrough)
   │
   └── throws ──▶ tryCustomFormatter ──▶ defaultFormat (formatToolError)
                          │                    │
                          ▼                    ▼
                       sanitizeSecrets ──▶ truncate ──▶ ToolResponse
                                                       { output: string,
                                                         metadata: {
                                                           error: true,
                                                           toolId,
                                                           code?, retryable? } }
```

### Phase / priority

| Field | Value | Reason |
|-------|-------|--------|
| `phase` | `"resolve"` (default) | Not interception, not pure observation — it transforms tool flow |
| `priority` | `170` | Outer layer — runs *after* inner middleware (e.g. semantic-retry at 420) has exhausted retries |

Lower priority = outer onion layer. Anything that should retry on its own (semantic-retry, circuit-breaker) sits inside this middleware and gets a chance before the throw is converted to text.

---

## Configuration

```typescript
interface ToolErrorFormatterConfig {
  /** Custom formatter. Falls back to default on throw or non-string return. */
  readonly formatter?: ToolErrorFormatter;
  /** Maximum error message length before truncation. Default: 1000. */
  readonly maxMessageLength?: number;
  /** Regex patterns for secrets to redact. Default: sk-* keys + Bearer tokens. */
  readonly secretPatterns?: readonly RegExp[];
}

type ToolErrorFormatter = (
  error: KoiError,
  toolId: string,
  input: JsonObject,
) => string | Promise<string>;
```

### Defaults

| Setting | Default |
|---------|---------|
| `maxMessageLength` | `1000` |
| `secretPatterns` | `[/sk-[A-Za-z0-9_-]{20,}/g, /Bearer\s+[A-Za-z0-9._~+/=-]+/g]` |
| `formatter` | `formatToolError` from `@koi/errors` |

---

## ToolResponse Shape

On error the middleware returns:

```typescript
{
  output: string,                    // human-readable, sanitized, truncated
  metadata: {
    error: true,
    toolId: string,
    code?: KoiErrorCode,             // present iff error is KoiError
    retryable?: boolean,             // present iff error is KoiError
  }
}
```

`metadata.error` is a stable contract that downstream middleware (audit, retry, telemetry) can rely on.

---

## Guardrail Passthrough

Hard-stop guardrail errors must propagate as throws — converting them into `ToolResponse` would let the engine continue past a deliberate abort. Errors whose `code` is in `passthroughCodes` skip formatting and re-throw.

Default `passthroughCodes`: `["RATE_LIMIT", "PERMISSION"]`.

| Source | Code | Why it must throw |
|--------|------|------------------|
| `@koi/middleware-call-limits` (`exitBehavior: "error"`) | `RATE_LIMIT` | Limit breach must terminate the turn |
| Permissions middleware deny path | `PERMISSION` | System refusal, not a tool failure |

Add codes to the set if your stack uses other guardrail middleware. Pass `[]` to format every error (legacy behavior).

Cancellation is also propagated: if `request.signal.aborted` is true or the caught error is an `AbortError` / `code === "ABORT_ERR"` / `code === "ABORTED"`, the throw re-emerges so the turn runner's cancellation path fires.

## Failure Modes

| Throw type | Handled |
|------------|---------|
| `KoiRuntimeError` | Yes — `code` + `retryable` propagated to metadata |
| Generic `Error` | Yes — message + tool id formatted |
| Non-Error throw (string, number, null, undefined) | Yes — coerced via `toKoiError` |
| Custom formatter throws | Falls back to default formatter |
| Custom formatter returns non-string | Falls back to default formatter |

The middleware itself never throws.

---

## Security

- All error messages, stacks, and structured `metadata.context` pass through `sanitizeSecrets` before being returned, regardless of formatter source.
- Default patterns redact OpenAI-style API keys (`sk-…`) and HTTP `Bearer` tokens.
- Caller-supplied `secretPatterns` are **merged with** the defaults — you cannot accidentally disable built-in redaction by adding a custom pattern. Set `replaceDefaultSecretPatterns: true` to opt out (rare; mostly for tests with predictable output).
- Truncation suffix `… (truncated)` is appended after sanitization, so secrets cannot escape via truncation boundaries.
- `metadata.context` is recursively sanitized (string values inside arrays / nested objects). Cycles in the context graph are replaced with the marker string `"[Circular]"` so cyclic error payloads cannot crash the formatter.

---

## Non-Goals

- **Retry**: belongs to `@koi/middleware-semantic-retry`. This middleware sits *outside* retry — it only fires when retry has given up.
- **Audit**: belongs to `@koi/middleware-audit`. The `metadata.error: true` flag is the contract for audit consumers.
- **Tool selection / disclosure**: belongs to peer middleware (`@koi/middleware-tool-disclosure`).
