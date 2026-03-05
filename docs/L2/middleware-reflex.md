# @koi/middleware-reflex — Rule-Based Short-Circuit

`@koi/middleware-reflex` is an L2 middleware package that intercepts `wrapModelCall` and returns rule-based responses for known message patterns — skipping the LLM entirely. Inspired by AIRI's three-layer cognitive architecture (Perception → Reflex → Conscious).

---

## Why It Exists

Every inbound message currently goes through the full LLM round-trip, even for simple patterns where the response is predictable — greetings, FAQ, status checks, help commands. Each round-trip costs tokens and adds latency.

```
Without reflex:
  "hello"    ─► LLM (800ms, 50 tokens)  ─► "Hello! How can I help?"
  "status"   ─► LLM (800ms, 80 tokens)  ─► "All systems operational."
  "help"     ─► LLM (800ms, 60 tokens)  ─► "Here are available commands..."
  Total: 2,400ms, 190 tokens

With reflex:
  "hello"    ─► regex match (0.1ms, 0 tokens) ─► "Hello! How can I help?"
  "status"   ─► regex match (0.1ms, 0 tokens) ─► "All systems operational."
  "help"     ─► regex match (0.1ms, 0 tokens) ─► "Here are available commands..."
  Total: 0.3ms, 0 tokens
```

The reflex middleware sits at the outermost intercept layer (priority 50) and short-circuits the model call pipeline before any downstream middleware even sees the request.

---

## Architecture

### Layer Position

```
L0  @koi/core                        ─ KoiMiddleware, ModelRequest, ModelResponse,
                                         TurnContext, InboundMessage (types only)
L0u @koi/resolve                     ─ BrickDescriptor (manifest auto-resolution)
L2  @koi/middleware-reflex           ─ this package (no L1 dependency)
```

### Internal Module Map

```
index.ts                    ← public re-exports
│
├── types.ts                ← ReflexRule, ReflexMetrics
├── config.ts               ← ReflexMiddlewareConfig, validateReflexConfig
├── text-of.ts              ← textOf() helper — extract text from InboundMessage
├── reflex.ts               ← createReflexMiddleware() factory
└── descriptor.ts           ← BrickDescriptor for manifest auto-resolution
```

### Middleware Priority

```
 50 ─ reflex             ← this package (intercept phase, outermost layer)
100 ─ permissions        ← access control
175 ─ call-limits        ← enforce call count budgets
185 ─ call-dedup         ← cache deterministic tool calls
200 ─ pay                ← billing
```

The reflex middleware runs at priority 50 in the `intercept` phase — before all other middleware. When a rule matches, the response is returned immediately and no downstream middleware executes. This means reflex responses are:
- **Zero-cost** — no billing middleware reached
- **Zero-latency** — no LLM round-trip
- **Transparent** — `describeCapabilities` returns `undefined` (invisible to agent system prompt)

---

## How It Works

### Rule Evaluation Flow

```
wrapModelCall invoked
  │
  ├─ Middleware disabled? ─────────► next(request)  (passthrough)
  │
  ├─ No messages in turn? ────────► next(request)  (passthrough)
  │
  ├─ Extract last message from ctx.messages
  │
  ├─ For each rule (sorted by priority, lower first):
  │   │
  │   ├─ Rule on cooldown? ────────► skip, try next rule
  │   │
  │   ├─ rule.match(message) throws? ─► skip, try next rule
  │   │
  │   ├─ rule.match(message) === false? ─► skip, try next rule
  │   │
  │   ├─ rule.respond(message, ctx) throws? ─► skip, try next rule
  │   │
  │   └─ Match! Build ModelResponse:
  │       content: rule.respond(message, ctx)
  │       model: "koi:reflex"
  │       usage: { inputTokens: 0, outputTokens: 0 }
  │       metadata: { reflexRule: ruleName, reflexHit: true }
  │       ─► fire onMetrics("hit") ─► return response (skip LLM)
  │
  └─ No rule matched ─► fire onMetrics("miss") ─► next(request)
```

### Cooldown Mechanism

Each rule can optionally specify a `cooldownMs` — a minimum interval between consecutive firings. This prevents a greeting rule from firing on every turn in rapid succession:

```typescript
const greetingRule: ReflexRule = {
  name: "greeting",
  match: (msg) => /^(hi|hello|hey)$/i.test(textOf(msg)),
  respond: () => "Hello! How can I help?",
  cooldownMs: 30_000,  // fire at most once per 30 seconds
};
```

Cooldown state is per-middleware-instance (not global), ensuring session isolation.

### Error Resilience

Both `match` and `respond` functions are called inside try/catch guards. If either throws, the rule is silently skipped and evaluation continues to the next rule. This ensures that a buggy rule never crashes the agent — it gracefully degrades to the LLM passthrough.

---

## API Reference

### `createReflexMiddleware(config)`

Factory function that creates a `KoiMiddleware` with a `wrapModelCall` hook.

```typescript
import { createReflexMiddleware } from "@koi/middleware-reflex";

const reflex = createReflexMiddleware({
  rules: [greetingRule, statusRule, helpRule],
  onMetrics: (m) => console.log(`reflex ${m.kind}: ${m.ruleName}`),
});
```

Returns `KoiMiddleware` with:
- `name`: `"koi:reflex"`
- `priority`: `50`
- `phase`: `"intercept"`
- `wrapModelCall`: rule evaluation logic
- `describeCapabilities`: returns `undefined` (transparent to LLM)

### `ReflexRule`

```typescript
interface ReflexRule {
  readonly name: string;
  readonly match: (message: InboundMessage) => boolean;
  readonly respond: (message: InboundMessage, ctx: TurnContext) => string;
  readonly priority?: number;      // lower = checked first, default 100
  readonly cooldownMs?: number;    // per-rule cooldown, default 0
}
```

### `ReflexMiddlewareConfig`

```typescript
interface ReflexMiddlewareConfig {
  readonly rules: readonly ReflexRule[];
  readonly enabled?: boolean;          // master switch, default true
  readonly now?: () => number;         // clock injection for testing
  readonly onMetrics?: (metrics: ReflexMetrics) => void;
}
```

### `ReflexMetrics`

```typescript
interface ReflexMetrics {
  readonly ruleName: string;
  readonly kind: "hit" | "miss";
  readonly interceptedContentLength?: number;  // chars of request (hit only)
  readonly responseLength?: number;            // chars of response (hit only)
  readonly latencyMs: number;
}
```

### `textOf(message)`

Utility that extracts concatenated text from an `InboundMessage`:

```typescript
import { textOf } from "@koi/middleware-reflex";

const text = textOf(message);  // joins all TextBlock.text with "\n"
```

### `validateReflexConfig(config)`

Validates raw input (e.g., from YAML) into a typed config:

```typescript
const result = validateReflexConfig({ rules: [myRule] });
if (result.ok) {
  const config = result.value;  // ReflexMiddlewareConfig
}
```

---

## Examples

### Manifest-Driven (koi.yaml)

```yaml
middleware:
  - name: reflex
    options:
      rules: ...
```

### Programmatic Factory

```typescript
import { createReflexMiddleware, textOf } from "@koi/middleware-reflex";
import type { ReflexRule } from "@koi/middleware-reflex";

const greetingRule: ReflexRule = {
  name: "greeting",
  match: (msg) => /^(hi|hello|hey)$/i.test(textOf(msg)),
  respond: () => "Hello! How can I help you today?",
  cooldownMs: 30_000,
};

const statusRule: ReflexRule = {
  name: "status",
  match: (msg) => /^status$/i.test(textOf(msg)),
  respond: () => "All systems operational.",
  priority: 200,
};

const helpRule: ReflexRule = {
  name: "help",
  match: (msg) => /^(help|commands|\?)$/i.test(textOf(msg)),
  respond: () => "Available commands: status, help, version",
};

const reflex = createReflexMiddleware({
  rules: [greetingRule, statusRule, helpRule],
  onMetrics: ({ kind, ruleName, latencyMs }) => {
    metrics.histogram("reflex.latency", latencyMs, { kind, rule: ruleName });
  },
});
```

### Dynamic Rules with Context

```typescript
const contextRule: ReflexRule = {
  name: "version",
  match: (msg) => /^version$/i.test(textOf(msg)),
  respond: (_msg, ctx) => `Agent ${ctx.session.agentId} v1.0.0`,
};
```

---

## What This Feature Enables

### 1. Zero-Token Responses
Reflex rules return responses without any LLM invocation. For predictable patterns (greetings, help, status), this eliminates 100% of token costs for those interactions.

### 2. Sub-Millisecond Latency
Rule matching is a synchronous function call — no network, no model inference. Responses arrive in microseconds instead of the 500ms–2s typical of LLM round-trips.

### 3. Predictable Behavior
Reflex responses are deterministic. The same input always produces the same output (modulo cooldowns). No temperature variance, no model drift, no hallucination risk for known patterns.

### 4. Graceful Degradation
Rules that throw are silently skipped. If all rules miss, the request passes through to the LLM unchanged. Adding reflexes never breaks existing behavior.

### 5. Observable Short-Circuits
The `onMetrics` callback reports hit/miss events with content lengths and latency. Teams can track reflex hit rates, identify patterns worth adding, and measure token savings.

### 6. Cooldown-Aware Throttling
Rules can specify a cooldown to avoid repetitive responses. A greeting rule fires once, then stays quiet for 30 seconds even if the user says "hi" again — the LLM handles the follow-up naturally.

### 7. Priority-Based Rule Ordering
Rules are sorted by priority at construction time (not per-call). Lower priority runs first. When multiple rules could match, the first match wins.

---

## Layer Compliance

```
@koi/middleware-reflex imports:
  ✅ @koi/core      (L0)  — KoiMiddleware, ModelRequest, ModelResponse, InboundMessage, etc.
  ✅ @koi/resolve    (L0u) — BrickDescriptor
  ❌ @koi/engine     (L1)  — NOT imported
  ❌ peer L2          —      NOT imported
```

All interface properties are `readonly`. No vendor types. No framework-isms.
