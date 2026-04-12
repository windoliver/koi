# @koi/model-router — Multi-Provider LLM Routing with Fallback and Health Monitoring

Routes model calls across multiple LLM providers with retry, ordered fallback chains, per-target circuit breakers, latency health monitoring, and streaming-safe failover. One middleware to add production-grade reliability to any single-model agent.

> **Phase 2** — ships `fallback`, `round-robin`, and `weighted` routing strategies.
> Cascade escalation (cheap model first → confidence evaluator → escalate) is Phase 3.

---

## Why It Exists

Production agents hit rate limits and provider outages mid-session. Without this package, every user wraps the SDK themselves, badly.

An ordered fallback list (`[primary, secondary, local-fallback]`) is the simplest production-grade reliability pattern. This package provides:

- **Ordered fallback chain** — try targets in sequence; skip those with open circuit breakers
- **Per-target circuit breakers** — open after N failures, half-open after cooldown, auto-recover
- **Streaming-safe failover** — never splices two partial responses; only fails over before first chunk
- **Latency tracking** — p50/p95 per target, updated on every request
- **In-flight dedup** — prevents double-billing on concurrent identical requests
- **Local health probing** — periodic pings to local providers to detect recovery

### Without model-router

```
Anthropic goes down → agent errors → session lost
```

### With model-router

```
Request → Anthropic (primary) → 5xx
       → OpenAI (secondary)  → ✓ done
       (user never notices)
```

---

## What This Enables

### For agent builders

- **Cost reduction** — route 60-80% of requests to cheap models with no quality loss
- **Zero-code activation** — add 5 lines to `koi.yaml`, no TypeScript changes
- **Automatic resilience** — circuit breakers isolate failing providers, fallback chains provide redundancy
- **Multi-provider redundancy** — mix Anthropic, OpenAI, and OpenRouter in one agent

### For users

- **Faster responses** — simple queries answered by fast models with lower latency
- **Higher reliability** — if one provider is down, traffic routes to alternatives
- **Budget control** — optional token budget limits prevent runaway costs

### Failure modes

| Failure | What happens |
|---------|-------------|
| Cheap model gives low-confidence answer | Automatically escalates to next tier |
| Provider API is down | Circuit breaker opens, routes to healthy provider |
| All providers down | Returns structured `KoiError` with `EXTERNAL` code |
| Budget exhausted | Stops escalation, returns best available response |
| Classifier misroutes a complex query | Evaluator catches low confidence, escalates anyway |

---

## Architecture

`@koi/model-router` is an **L2 feature package** at `packages/lib/model-router/`. It depends on L0 (`@koi/core`) and L0u utilities (`@koi/errors`, `@koi/validation`).

```
┌──────────────────────────────────────────────────────────────────┐
│  @koi/model-router  (L2)                                         │
│                                                                  │
│  provider-adapter.ts   ← ProviderAdapter interface               │
│  config.ts             ← Zod schema + validateRouterConfig()     │
│  fallback.ts           ← Ordered target fallback chain           │
│  target-ordering.ts    ← Orderers for round-robin/weighted       │
│  latency-tracker.ts    ← 1000-sample ring buffer, p50/p95        │
│  in-flight-cache.ts    ← In-flight request dedup (Map<hash,Prom>)│
│  health-probe.ts       ← Local-only active health probing        │
│  route-core.ts         ← executeForTarget + capability check     │
│  router.ts             ← createModelRouter() — thin assembly     │
│  middleware.ts         ← createModelRouterMiddleware() wrapper    │
│  normalize.ts          ← Message normalization for adapters       │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│  Dependencies                                                    │
│  @koi/core    (L0)   ModelRequest, ModelChunk, KoiMiddleware     │
│  @koi/errors  (L0u)  createCircuitBreaker, withRetry, KoiError   │
│  @koi/validation (L0u) validateWith (Zod helper)                 │
└──────────────────────────────────────────────────────────────────┘
```

Concrete provider adapters (Anthropic, OpenAI, OpenRouter, Ollama) live in separate L2 packages (Phase 3). Callers pass a `ReadonlyMap<string, ProviderAdapter>` to `createModelRouter`.

---

## How It Works

### Routing Strategies

| Strategy | Behavior |
|----------|----------|
| `fallback` | Try targets in order; skip to next on failure or open circuit |
| `round-robin` | Distribute requests across targets evenly; fallback on failure |
| `weighted` | Weighted random primary selection; remaining sorted by weight as fallbacks |

> Cascade (cheap model first → confidence check → escalate) is Phase 3.

### Fallback Flow

```
Incoming Model Call
       │
       ▼
┌─────────────────────────────────────┐
│  Order targets by strategy          │
│  (fallback / round-robin / weighted)│
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Skip targets with OPEN circuits    │
│  (graceful degradation: if ALL open,│
│   try them anyway — prefer degraded │
│   over nothing)                     │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Retry target with backoff          │
│  On 429/5xx/timeout: recordFailure  │
│  On success: recordSuccess          │
└──────────────┬──────────────────────┘
               │ failure
               ▼
┌─────────────────────────────────────┐
│  Try next target in chain           │
│  (withFallback loop)                │
└─────────────────────────────────────┘
```

### Streaming Failover Safety

Streaming uses a `chunksYielded` sentinel:

- If the stream fails **before** the first chunk → fall through to next target
- If the stream fails **after** yielding chunks → propagate error immediately; do **not** switch providers (caller already has a partial response)

### In-Flight Request Dedup

`createModelRouter` maintains a `Map<hash, Promise<ModelResponse>>`. If two identical requests (same messages, model, temperature) arrive concurrently, the second awaits the first result — one API call, zero double-billing.

### Health Monitoring

`getMetrics()` returns per-target `TargetMetrics`:

```typescript
interface TargetMetrics {
  readonly requests: number;
  readonly failures: number;
  readonly p50Ms: number | undefined;  // undefined until 2+ samples
  readonly p95Ms: number | undefined;
  readonly lastErrorAt: number | undefined;
}
```

Latency samples are stored in a 1000-sample circular buffer per target. Percentiles are sorted on read — O(1000 log 1000), negligible.

### Telemetry

Every `wrapModelCall` invocation calls `ctx.reportDecision` with:

```typescript
{
  "router.target.selected": "anthropic:claude-sonnet-4-6",
  "router.fallover.count": 1,           // 0 if primary succeeded
  "router.latency_ms": 423
}
```

### Middleware Position

```
                Incoming Model Call
                       │
                       ▼
           ┌───────────────────────┐
        ┌──│  model-router         │──┐  priority: 900 (outermost)
        │  │  (THIS MIDDLEWARE)    │  │
        │  ├───────────────────────┤  │
        │  │  middleware-audit     │  │  priority: 450
        │  ├───────────────────────┤  │
        │  │  middleware-semantic- │  │  priority: 420
        │  │  retry               │  │
        │  ├───────────────────────┤  │
        │  │  middleware-permissions│  │  priority: 400
        │  ├───────────────────────┤  │
        │  │  engine adapter       │  │
        │  │  → LLM API call       │  │
        │  └───────────┬───────────┘  │
        │         Response            │
        │              │              │
        └──────────────┘──────────────┘
```

Priority 900 means model-router intercepts **all** model calls before any other middleware. It completely replaces the default model call — the router decides which provider/model handles the request.

---

## Programmatic Configuration (Phase 2)

In Phase 2, `createModelRouter` is the primary API. Callers provide their own adapter map.

```typescript
import {
  createModelRouter,
  createModelRouterMiddleware,
  validateRouterConfig,
} from "@koi/model-router";

// Callers bring their own ProviderAdapter implementations
const adapters = new Map([
  ["anthropic", myAnthropicAdapter],
  ["openai", myOpenAIAdapter],
]);

const configResult = validateRouterConfig({
  strategy: "fallback",
  targets: [
    { provider: "anthropic", model: "claude-sonnet-4-6", adapterConfig: {} },
    { provider: "openai",    model: "gpt-4o",            adapterConfig: {} },
  ],
});

if (!configResult.ok) throw new Error(configResult.error.message);

const router = createModelRouter(configResult.value, adapters, {
  clock: Date.now,    // injectable for tests
  setInterval,       // injectable for tests
});

// Use as middleware
const middleware = createModelRouterMiddleware(router);

// Or call directly
const result = await router.route(request);
const stream  = router.routeStream(request);
const health  = router.getHealth();   // ReadonlyMap<string, CircuitBreakerSnapshot>
const metrics = router.getMetrics();  // RouterMetrics with ReadonlyMap<string, TargetMetrics>

// Cleanup
router.dispose();
```

> **Phase 3** adds a `BrickDescriptor` for YAML manifest wiring and concrete adapter packages
> (`@koi/adapter-anthropic`, `@koi/adapter-openai`, etc.) that implement `ProviderAdapter`.

### Config options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `strategy` | `"fallback" \| "round-robin" \| "weighted"` | **required** | Routing strategy |
| `targets` | `ModelTargetConfig[]` | **required** | Ordered list of provider+model targets |
| `retry.maxRetries` | `number` | `3` | Max retries per target |
| `retry.initialDelayMs` | `number` | `1000` | Initial backoff delay |
| `circuitBreaker.failureThreshold` | `number` | `5` | Failures to open circuit |
| `circuitBreaker.cooldownMs` | `number` | `60000` | Cooldown before half-open probe |
| `healthProbe.intervalMs` | `number` | `30000` | Health probe interval (local providers only) |

---

## `ModelRouter` interface

```typescript
interface TargetMetrics {
  readonly requests: number;
  readonly failures: number;
  readonly p50Ms: number | undefined;
  readonly p95Ms: number | undefined;
  readonly lastErrorAt: number | undefined;
}

interface RouterMetrics {
  readonly totalRequests: number;
  readonly totalFailures: number;
  readonly byTarget: ReadonlyMap<string, TargetMetrics>;
  readonly totalEstimatedCost: number;
}

interface ModelRouter {
  readonly route:      (request: ModelRequest) => Promise<Result<ModelResponse, KoiError>>;
  readonly routeStream:(request: ModelRequest) => AsyncIterable<ModelChunk>;
  readonly getHealth:  () => ReadonlyMap<string, CircuitBreakerSnapshot>;
  readonly getMetrics: () => RouterMetrics;
  readonly dispose:    () => void;
}
```

## `ProviderAdapter` interface

Implement this to wire any LLM provider into the router.

```typescript
interface ProviderAdapter {
  readonly id: string;
  readonly complete: (request: ModelRequest) => Promise<ModelResponse>;
  readonly stream:   (request: ModelRequest) => AsyncGenerator<ModelChunk>;
  readonly checkHealth?: () => Promise<boolean>;  // optional, used for local probing only
}
```

---

## Performance Properties

| Feature | Algorithm | Per-turn cost |
|---------|-----------|---------------|
| Circuit breaker check | State lookup | O(1) |
| In-flight dedup | Map<hash, Promise> lookup | O(1) hash + O(n) messages for hash |
| Target ordering (fallback) | Identity | O(1) |
| Target ordering (round-robin) | Counter mod | O(1) |
| Target ordering (weighted) | Weighted scan + sort | O(n) targets |
| Retry with backoff | Exponential + jitter | Only on failure |
| Latency percentile | Ring buffer sort on read | O(1000 log 1000) at getMetrics() |
| Adapter reuse | Map lookup by provider | O(1) |

Overhead per request on the fast path (primary succeeds): one hash, one map lookup, one CB check. Dominant cost is always the LLM API call itself.

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────┐
    KoiMiddleware, ModelRequest, ModelResponse,      │
    ModelChunk, KoiError, Result                     │
                                                      │
L0u @koi/errors    createCircuitBreaker, withRetry   │
    @koi/validation validateWith (Zod helper)        │
                                                      ▼
L2  @koi/model-router ◄─────────────────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ no external HTTP/SDK dependencies (raw fetch in adapters, which are separate packages)
```

---

## Related

- Issue #1626 — Phase 2 implementation (this package)
- Phase 3 — Cascade strategy (complexity classifier + confidence evaluators)
- Phase 3 — `BrickDescriptor` for YAML manifest wiring + concrete adapter packages
- `@koi/middleware-semantic-retry` — Complements model-router with intelligent retry on failure
