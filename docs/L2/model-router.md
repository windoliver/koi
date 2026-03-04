# @koi/model-router — Multi-Provider LLM Routing with Cascade Escalation

Routes model calls across multiple LLM providers with retry, fallback chains, cascade escalation (cheap model first → evaluate confidence → escalate), circuit breakers, and manifest-driven configuration. One middleware to replace single-model setups with intelligent multi-model routing.

---

## Why It Exists

When an LLM agent uses a single model, you face a tradeoff:

1. **Use a cheap model** — fast and affordable, but struggles with complex reasoning tasks
2. **Use an expensive model** — handles everything, but 10-30x the cost for simple queries

Most agent requests are simple (greetings, lookups, reformulations). A minority are complex (multi-step reasoning, code generation, architectural planning). Routing all traffic to one model wastes money or capability.

This package solves the problem with **cascade routing**: start with a cheap model, evaluate its response confidence, and escalate to a stronger model only when needed. Combined with circuit breakers, retry, and fallback chains, it makes multi-model setups production-ready.

### Without model-router

```
Every request → Claude Sonnet → $$$
(even "what time is it?" uses the expensive model)
```

### With model-router (cascade)

```
Request → Complexity Classifier (<1ms)
   │
   ├─ Simple → Haiku → confidence check → ✓ done ($)
   │
   └─ Complex → skip Haiku → Sonnet directly ($$)
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

`@koi/model-router` is an **L2 feature package** at `packages/drivers/model-router/`. It depends on L0 (`@koi/core`) and L0u utilities (`@koi/errors`, `@koi/validation`, `@koi/token-estimator`, `@koi/resolve`).

```
┌──────────────────────────────────────────────────────────────────┐
│  @koi/model-router  (L2)                                         │
│                                                                  │
│  adapters/                                                       │
│    anthropic.ts        ← Anthropic Messages API (raw fetch)      │
│    openai.ts           ← OpenAI Chat Completions                 │
│    openrouter.ts       ← OpenRouter (OpenAI-compatible)          │
│    openai-compat.ts    ← Shared base for OpenAI-compatible APIs  │
│    ollama.ts           ← Local Ollama                            │
│    lm-studio.ts        ← Local LM Studio                        │
│    vllm.ts             ← vLLM inference server                   │
│    discover.ts         ← Auto-discover local providers           │
│                                                                  │
│  cascade/                                                        │
│    complexity-classifier.ts  ← 14-dimension heuristic scorer     │
│    evaluators.ts             ← Length, keyword, LLM evaluators   │
│    cascade.ts                ← Cascade orchestration loop        │
│    cascade-metrics.ts        ← Per-tier cost tracking            │
│                                                                  │
│  config.ts             ← Zod schema + validateRouterConfig()     │
│  router.ts             ← createModelRouter() — main service      │
│  middleware.ts          ← createModelRouterMiddleware() wrapper   │
│  descriptor.ts          ← BrickDescriptor for manifest wiring    │
│  circuit-breaker.ts     ← Per-target circuit breaker             │
│  retry.ts               ← Exponential backoff with jitter        │
│  fallback.ts            ← Ordered target fallback chain          │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│  Dependencies                                                    │
│  @koi/core              (L0)   Types, ModelRequest, KoiMiddleware│
│  @koi/errors            (L0u)  KoiError constructors             │
│  @koi/validation        (L0u)  Zod schema helpers                │
│  @koi/token-estimator   (L0u)  Token counting for classifier     │
│  @koi/resolve           (L0u)  BrickDescriptor, ResolutionContext│
└──────────────────────────────────────────────────────────────────┘
```

---

## How It Works

### Routing Strategies

| Strategy | Behavior |
|----------|----------|
| `cascade` | Cheap model first → evaluate confidence → escalate if below threshold |
| `fallback` | Try targets in order, skip to next on failure |
| `round-robin` | Distribute requests across targets evenly |
| `weighted` | Distribute by configured weights (0-1) |

### Cascade Flow

```
Incoming Model Call
       │
       ▼
┌─────────────────────────────────────┐
│  Complexity Classifier (<1ms)       │
│  14 dimensions → score → tier       │
│                                     │
│  LIGHT  (score < 0.25) → Tier 0    │
│  MEDIUM (0.25 - 0.6)   → Tier 0    │
│  HEAVY  (score > 0.6)  → Tier 1+   │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Execute on recommended tier        │
│  (e.g., Haiku for LIGHT)            │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Confidence Evaluator               │
│  Length heuristic + keyword check    │
│  composed with "min" strategy       │
│                                     │
│  confidence >= 0.7 → return result  │
│  confidence <  0.7 → escalate       │
└──────────────┬──────────────────────┘
               │ (escalate)
               ▼
┌─────────────────────────────────────┐
│  Execute on next tier (e.g., Sonnet)│
│  → return result                    │
└─────────────────────────────────────┘
```

### Complexity Classifier — 14 Dimensions

The classifier scores requests across 14 dimensions in <1ms (pure heuristic, no LLM call):

| Dimension | What it measures |
|-----------|-----------------|
| `reasoning` | Logical reasoning keywords (analyze, compare, evaluate) |
| `code` | Code generation/review indicators |
| `multiStep` | Sequential task markers (first, then, finally) |
| `technical` | Domain-specific vocabulary density |
| `outputFormat` | Structured output requirements (JSON, table, list) |
| `domain` | Specialized domain markers (legal, medical, financial) |
| `tokenCount` | Raw input length (longer = likely more complex) |
| `questionComplexity` | Question structure complexity |
| `imperativeVerbs` | Task-oriented action words |
| `constraints` | Explicit constraints (must, exactly, no more than) |
| `creative` | Creative writing indicators |
| `simpleIndicators` | Simple query signals — **negative weight** |
| `relay` | Pass-through/relay patterns — **negative weight** |
| `agentic` | Multi-tool/agent coordination markers |

### Confidence Evaluators

Two built-in evaluators, composed with `"min"` strategy (conservative — both must pass):

| Evaluator | Logic |
|-----------|-------|
| **Length heuristic** | Score based on response length. <10 chars → 0.0, ≥200 chars → 1.0, linear in between |
| **Keyword** | Penalize 0.2 per uncertainty marker ("I'm not sure", "I don't know", etc.) |

Optional third evaluator (not auto-wired): **Verbalized** — asks an LLM to self-rate confidence.

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

## Manifest Configuration

### Basic cascade (recommended)

```yaml
middleware:
  - model-router:
      strategy: cascade
      confidenceThreshold: 0.7
      targets:
        - anthropic:claude-haiku-4-5
        - anthropic:claude-sonnet-4-5
```

### Multi-provider fallback

```yaml
middleware:
  - model-router:
      strategy: fallback
      targets:
        - anthropic:claude-sonnet-4-5
        - openai:gpt-4o
```

### Full cascade with options

```yaml
middleware:
  - model-router:
      strategy: cascade
      confidenceThreshold: 0.7
      maxEscalations: 2
      budgetLimitTokens: 100000
      targets:
        - anthropic:claude-haiku-4-5
        - anthropic:claude-sonnet-4-5
        - anthropic:claude-opus-4-5
```

### YAML options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `strategy` | `"cascade" \| "fallback" \| "round-robin" \| "weighted"` | **required** | Routing strategy |
| `targets` | `string[]` | **required** | List of `"provider:model"` strings, ordered cheapest → most expensive |
| `confidenceThreshold` | `number` (0-1) | `0.7` | Minimum confidence to accept a response (cascade only) |
| `maxEscalations` | `number` | `tiers.length - 1` | Max tier jumps per request (cascade only) |
| `budgetLimitTokens` | `number` | `0` (disabled) | Total token budget across all tiers (cascade only) |

### Supported providers

| Provider prefix | Env variable | API |
|----------------|-------------|-----|
| `anthropic` | `ANTHROPIC_API_KEY` | Anthropic Messages API |
| `openai` | `OPENAI_API_KEY` | OpenAI Chat Completions |
| `openrouter` | `OPENROUTER_API_KEY` | OpenRouter (OpenAI-compatible) |

API keys are read from environment variables automatically — no need to configure them in YAML.

---

## Programmatic API

### `createModelRouter(config, adapters, options)`

Creates the core router service.

```typescript
import {
  createModelRouter,
  createAnthropicAdapter,
  createComplexityClassifier,
  createLengthHeuristicEvaluator,
  createKeywordEvaluator,
  composeEvaluators,
  validateRouterConfig,
} from "@koi/model-router";

const adapters = new Map([
  ["anthropic", createAnthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! })],
]);

const configResult = validateRouterConfig({
  strategy: "cascade",
  targets: [
    { provider: "anthropic", model: "claude-haiku-4-5", adapterConfig: {} },
    { provider: "anthropic", model: "claude-sonnet-4-5", adapterConfig: {} },
  ],
  cascade: {
    tiers: [
      { targetId: "anthropic:claude-haiku-4-5" },
      { targetId: "anthropic:claude-sonnet-4-5" },
    ],
    confidenceThreshold: 0.7,
  },
});

if (!configResult.ok) throw new Error(configResult.error.message);

const router = createModelRouter(configResult.value, adapters, {
  classifier: createComplexityClassifier(),
  evaluator: composeEvaluators(
    [createLengthHeuristicEvaluator(), createKeywordEvaluator()],
    "min",
  ),
});

const result = await router.route(request);
```

### `createModelRouterMiddleware(router)`

Wraps a `ModelRouter` as `KoiMiddleware` (priority 900).

```typescript
import { createModelRouterMiddleware } from "@koi/model-router";

const middleware = createModelRouterMiddleware(router);
// middleware.name === "model-router"
// middleware.priority === 900
```

### `ModelRouter` interface

```typescript
interface ModelRouter {
  readonly route: (request: ModelRequest) => Promise<Result<ModelResponse, KoiError>>;
  readonly routeStream: (request: ModelRequest) => AsyncGenerator<StreamChunk>;
  readonly getHealth: () => ReadonlyMap<string, CircuitBreakerSnapshot>;
  readonly getMetrics: () => RouterMetrics;
  readonly dispose: () => void;
}
```

---

## Performance Properties

| Feature | Algorithm | Per-turn cost |
|---------|-----------|---------------|
| Complexity classification | 14-dim heuristic scoring | <1ms, zero allocations on hot path |
| Length evaluator | String length comparison | O(1) |
| Keyword evaluator | 10-marker scan | O(n) where n = response length |
| Circuit breaker check | State lookup | O(1) |
| Retry with backoff | Exponential + jitter | Only on failure |
| Adapter reuse | Map lookup by provider | O(1) |

The classifier and evaluators add negligible overhead. The dominant cost is always the LLM API call itself. Cascade routing **saves** latency on simple requests by using faster cheap models.

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────┐
    KoiMiddleware, ModelRequest, ModelResponse,      │
    KoiError, Result                                 │
                                                      │
L0u @koi/errors, @koi/validation,                    │
    @koi/token-estimator, @koi/resolve               │
                                                      ▼
L2  @koi/model-router ◄─────────────────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external HTTP/SDK dependencies (uses raw fetch)
```

---

## Related

- Issue #681 — Phase routing (planning model → execution model) extension
- `docs/architecture/manifest-resolution.md` — How descriptors are resolved from koi.yaml
- `@koi/middleware-semantic-retry` — Complements model-router with intelligent retry on failure
