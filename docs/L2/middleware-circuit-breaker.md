# @koi/middleware-circuit-breaker — Provider Fail-Fast

Per-provider circuit breaker for model calls. When a provider accumulates too many recent failures, the circuit opens and subsequent calls fail fast with a `RATE_LIMIT` `KoiError` instead of waiting for upstream timeouts.

Wraps the `createCircuitBreaker` primitive from `@koi/errors` and applies it as a middleware on `wrapModelCall` and `wrapModelStream`.

---

## Why It Exists

Without a circuit breaker, an unhealthy provider drags every turn through full upstream timeouts (often 30s+) before returning an error. The agent loop wastes wall-clock time and tokens on retries that cannot succeed.

This middleware:

1. Tracks failures per provider key (default: `request.model` prefix before `/`, e.g. `openai/gpt-4o` → `openai`)
2. Opens the circuit on N failures within a window
3. Fails fast for the cooldown period
4. Allows a single probe call in `HALF_OPEN` to detect recovery

The model-router (separate package, future) handles failover. This middleware only stops sending to a known-bad provider — it does not route requests elsewhere.

---

## Surface

```ts
export interface CircuitBreakerMiddlewareConfig {
  readonly breaker?: Partial<CircuitBreakerConfig>;
  readonly extractKey?: (model: string | undefined) => string;
  readonly maxKeys?: number;
}

export function createCircuitBreakerMiddleware(
  config?: CircuitBreakerMiddlewareConfig,
): KoiMiddleware;
```

- `breaker` — overrides for `failureThreshold`, `cooldownMs`, `failureWindowMs`, `failureStatusCodes`. Defaults from `@koi/errors`.
- `extractKey` — maps `request.model` to a circuit key. Default extractor: `model.split("/")[0]` or `"default"`.
- `maxKeys` — bound on the per-key Map size. Default 50. One-shot warning when exceeded (defends against pathological key explosion).

Phase: `intercept`. Priority: 175.

---

## Behavior

| Event | Action |
|---|---|
| `wrapModelCall` and circuit `CLOSED`/`HALF_OPEN` allows | call `next`; record success/failure on outcome |
| `wrapModelCall` and circuit `OPEN` (cooldown not elapsed) | throw `RATE_LIMIT` KoiError, do not call `next` |
| `wrapModelStream` and circuit closed | yield from `next(req)`; record success on terminal `done`, failure on terminal `error` |
| `wrapModelStream` and circuit open | yield single `error` chunk, return |
| Status code in `failureStatusCodes` | counts as failure; others ignored |
| Probe in `HALF_OPEN` succeeds | transition to `CLOSED`, reset ring buffer |
| Probe in `HALF_OPEN` fails | transition back to `OPEN` |

`describeCapabilities` returns either "All provider circuits closed (healthy)." or `"Circuit open for: <providers>."`.

---

## Tests (must pass)

- Trips after `failureThreshold` failures within `failureWindowMs`
- Allows probe after `cooldownMs` (HALF_OPEN)
- Probe success resets to CLOSED
- Probe failure returns to OPEN
- Status codes outside `failureStatusCodes` do not count
- `wrapModelStream` records success on `done`, failure on `error`
- Multiple providers tracked independently
- Happy path: zero allocations beyond Map lookup when circuit closed

---

## Out of Scope

- Failover to alternate models (model-router responsibility)
- Distributed circuit state (per-process only; future Nexus-backed adapter)
- Per-tool circuit breaking (see `@koi/middleware-call-limits`)
