# Capability Injection — Self-Describing Middleware

Middleware in Koi operates as an invisible interposition layer. The LLM has no idea what middleware is active, what constraints it enforces, or what capabilities it provides. This leads to wasted turns: calling tools that permissions will deny, exceeding budgets that pay will enforce, producing output that guardrails will reject.

Capability injection solves this by giving each middleware a **required** `describeCapabilities` hook. Before every model call, the engine aggregates all descriptions into a single prepended system message so the LLM knows what's available and what's restricted.

---

## The Problem

```
User: "Delete the temp files and deploy to prod"

  LLM (blind)                     Middleware
  ─────────────                   ──────────
  "Sure, deleting                 permissions: deploy_prod
   and deploying"                 requires approval
       │
       ▼
  Tool: delete_temp ──── OK
  Tool: deploy_prod ──── DENIED by permissions middleware

  LLM retries, burns tokens, confuses the user.
  It had no way to know deploy_prod needed approval.
```

## The Solution

```
  ┌─────────────────────────────────────────────────────────┐
  │  ModelRequest.messages[0]                               │
  │                                                         │
  │  [Active Capabilities]                                  │
  │  - **permissions**: Tools requiring approval:           │
  │    deploy_prod, rm -rf. Default: allow                  │
  │  - **budget**: Token budget: 8,500 of 10,000 remaining  │
  │  - **guardrails**: Output must conform to JSON schema.  │
  │    Max 3 retries on validation failure                  │
  └─────────────────────────────────────────────────────────┘

  LLM (informed): "I see deploy_prod requires approval.
   I'll delete the temp files now. For deploy, I need
   your approval first — shall I proceed?"

  No wasted turns. The LLM respects constraints proactively.
```

---

## Architecture

Capability injection spans all three layers:

```
L0  @koi/core
    ├── CapabilityFragment          { readonly label: string; readonly description: string }
    └── KoiMiddleware
        └── describeCapabilities    (ctx: TurnContext) => CapabilityFragment | undefined  [REQUIRED]

L1  @koi/engine
    ├── collectCapabilities()       Iterates middleware, calls describeCapabilities, try/catch per-mw
    ├── formatCapabilityMessage()   Formats fragments into InboundMessage (senderId: "system:capabilities")
    ├── injectCapabilities()        Prepends capability message to ModelRequest.messages
    └── koi.ts prepareRequest()     Injects tools + capabilities before the onion chain

L2  All middleware packages
    └── describeCapabilities()      Returns a CapabilityFragment describing what the middleware does
```

### Data Flow

```
  ┌──────────┐   describeCapabilities(ctx)   ┌──────────┐
  │middleware │──────────────────────────────▶│ Fragment  │
  │ "budget"  │   { label: "budget",          │ label    │
  │ priority: │     description: "Token       │ desc     │
  │   200     │     budget: 8500/10000" }     └────┬─────┘
  └──────────┘                                     │
                                                   │
  ┌──────────┐   describeCapabilities(ctx)   ┌─────┴─────┐
  │middleware │──────────────────────────────▶│ Fragment  │
  │"permiss." │   { label: "permissions",     │ label    │
  │ priority: │     description: "..." }      │ desc     │
  └──────────┘                                └────┬─────┘
                                                   │
  ┌──────────┐   return undefined                  │
  │middleware │──────────────────────── (skipped)   │
  │ "audit"   │   (no public description)          │
  └──────────┘                                     │
                                                   │
         collectCapabilities()                     │
         ┌─────────────────────────────────────┐   │
         │ 1. Iterate middleware by priority    │   │
         │ 2. Call describeCapabilities(ctx)    │◀──┘
         │ 3. try/catch per middleware          │
         │ 4. Skip undefined returns            │
         │ 5. Return CapabilityFragment[]       │
         └──────────────────┬──────────────────┘
                            │
         formatCapabilityMessage()
         ┌──────────────────┴──────────────────┐
         │ [Active Capabilities]               │
         │ - **permissions**: Tools requiring...│
         │ - **budget**: Token budget: 8500...  │
         │                                     │
         │ senderId: "system:capabilities"     │
         └──────────────────┬──────────────────┘
                            │
         prepareRequest()   │
         ┌──────────────────┴──────────────────┐
         │ ModelRequest                        │
         │   messages: [                       │
         │     capability msg,  <── injected   │
         │     user msg,                       │
         │   ]                                 │
         │   tools: [...]                      │
         └──────────────────┬──────────────────┘
                            │
                            ▼
                  Onion chain → LLM terminal
```

---

## How to Implement `describeCapabilities`

### Interface

```typescript
// L0: @koi/core
interface CapabilityFragment {
  readonly label: string;       // short identifier, e.g. "budget"
  readonly description: string; // actionable, concise, factual
}

// On KoiMiddleware (REQUIRED since v0.x — was optional before):
readonly describeCapabilities: (ctx: TurnContext) => CapabilityFragment | undefined;
```

### Good Descriptions

Concise, factual, actionable. Tell the LLM what it needs to know to make decisions:

```
label: "permissions"
description: "Tools requiring approval: fs:write, shell:exec. Default: allow"

label: "budget"
description: "Token budget: 8,500 of 10,000 remaining"

label: "guardrails"
description: "Output must conform to JSON schema: { type: 'object' }. Max 3 retries"
```

### Bad Descriptions

Verbose, self-referential, or unhelpful:

```
"I am the permissions middleware and I enforce access control policies across all tool calls..."
"Budget middleware is active and tracking token usage for this session"
"This middleware validates output"
```

### Static vs Dynamic

**Static** — Compute once at factory time, return the cached object. Use when the description doesn't change per-turn:

```typescript
export function createAuditMiddleware(config: AuditConfig): KoiMiddleware {
  const fragment: CapabilityFragment = {
    label: "audit",
    description: "Compliance audit logging active",
  };
  return {
    name: "audit",
    describeCapabilities: () => fragment,
    // ...
  };
}
```

**Dynamic** — Compute from runtime state each time. Use when the description reflects changing state (budgets, counters, active features):

```typescript
export function createPayMiddleware(config: PayConfig): KoiMiddleware {
  let remaining = config.maxBudget;
  return {
    name: "pay",
    describeCapabilities: (): CapabilityFragment => ({
      label: "budget",
      description: `Token budget: ${remaining} of ${config.maxBudget} remaining`,
    }),
    // ...
  };
}
```

### Returning `undefined`

Return `undefined` to skip injection for this middleware. Useful when a middleware has nothing meaningful to report:

```typescript
describeCapabilities: (ctx) => {
  if (noActiveRules) return undefined;
  return { label: "rules", description: `${activeRules.length} rules active` };
},
```

---

## Middleware Adoption

All middleware packages implement `describeCapabilities` (required since Issue #515):

| Package | Label | Description Pattern | Static/Dynamic |
|---------|-------|-------------------|----------------|
| `middleware-permissions` | `permissions` | "Tools requiring approval: {list}. Default: {allow/deny}" | Static |
| `middleware-turn-ack` | `turn-ack` | "Turn acknowledgment active" | Static |
| `middleware-call-limits` | `rate-limits` | "Rate limit: {n} calls per tool" | Static |
| `middleware-pay` | `budget` | "Token budget: {remaining} of {total} remaining" | Dynamic |
| `middleware-compactor` | `compactor` | "Context compaction active above {threshold} tokens" | Static |
| `middleware-context-editing` | `context-editing` | "Old tool results cleared above {threshold} tokens" | Static |
| `middleware-audit` | `audit` | "Compliance audit logging active" | Static |
| `middleware-pii` | `pii` | "PII detection and redaction active" | Static |
| `middleware-sanitize` | `sanitize` | "Input/output sanitization active" | Static |
| `middleware-fs-rollback` | `fs-rollback` | "Filesystem rollback on error enabled" | Static |
| `middleware-ace` | `playbooks` | "Active playbooks: {count}" | Dynamic |
| `middleware-guardrails` | `guardrails` | "Output validation: {schema}. Max {n} retries" | Static |
| `middleware-memory` | `memory` | "Long-term memory active ({strategy} recall)" | Static |
| `middleware-tool-selector` | `tool-filter` | "Tool filtering active" | Static |
| `middleware-semantic-retry` | `semantic-retry` | "Semantic retry on model errors" | Static |
| `middleware-guided-retry` | `guided-retry` | "Guided retry with structural repair" | Static |
| `middleware-feedback-loop` | `feedback` | "Validation with feedback loop active" | Static |
| `middleware-event-trace` | `tracing` | "Event tracing active" | Static |
| `middleware-planning` | `planning` | "Planning mode: {enabled/disabled}" | Dynamic |
| `soul` | `soul` | "Persona active: {name}" | Static |
| `middleware-sandbox` | `sandbox` | "Tool sandboxing active for untrusted tools" | Static |
| `context` (hydrator) | `context` | "Context hydration active with {n} sources" | Static |
| `identity` | `identity` | "Identity: {n} persona(s) configured" | Static |
| `middleware-goal-anchor` | `goals` | "{completed}/{total} objectives completed" | Dynamic |
| `middleware-governance-backend` | `governance` | "Policy evaluation gate active..." | Static |

### Forge Integration

Forged middleware bricks automatically get `describeCapabilities` via `brickCapabilityFragment()`:

```typescript
import { brickCapabilityFragment } from "@koi/forge";

// Auto-maps BrickArtifact.name → label, BrickArtifact.description → description
const fragment = brickCapabilityFragment(brick);
// { label: "rate-limiter", description: "Rate limiting middleware" }
```

Agents update the description by re-forging (new content hash = new brick).

---

## Performance

### Fast Path

When all middleware return `undefined` from `describeCapabilities`, the engine skips message injection (zero-allocation):

```
Per model call:
  prepareRequest(request):
    ├── request.tools exists?       YES → withTools = request (same ref, 0 alloc)
    └── collectCapabilities(mw, ctx)
        ├── all return undefined?   YES → return withTools (0 alloc)
        └── has fragments?          YES → formatCapabilityMessage + prepend
```

### Allocation Profile

| Path | Allocations | When |
|------|------------|------|
| All undefined | 1 array (empty) | All middleware return `undefined` from `describeCapabilities` |
| With capabilities | 1 array + 1 message object + 1 request spread | Per model call when middleware describes capabilities |
| Error in describeCapabilities | 0 extra | Caught, logged, skipped — other middleware still injected |

### Token Budget Guard

Optional `maxCapabilityTokens` on `CapabilityInjectionConfig` truncates fragments from the end when the aggregated message exceeds the budget:

```typescript
const runtime = await createKoi({
  manifest,
  adapter,
  middleware,
  capabilityConfig: { maxCapabilityTokens: 200 }, // heuristic: ~4 chars/token
});
```

---

## Error Isolation

Each middleware's `describeCapabilities` is wrapped in try/catch. A broken middleware never crashes the system:

```
collectCapabilities():
  for each middleware:
    try:
      fragment = mw.describeCapabilities(ctx)
      if fragment !== undefined → push to results
    catch:
      console.warn("Middleware X threw, skipping")
      continue  ← other middleware still collected
```

---

## API Reference

### Types (L0)

```typescript
interface CapabilityFragment {
  readonly label: string;
  readonly description: string;
}
```

### Functions (L1)

```typescript
// Collect fragments from all middleware (error-isolated)
function collectCapabilities(
  middleware: readonly KoiMiddleware[],
  ctx: TurnContext,
): readonly CapabilityFragment[]

// Format fragments into a system message
function formatCapabilityMessage(
  fragments: readonly CapabilityFragment[],
): InboundMessage

// Inject capability message into a model request (zero-alloc fast-path)
function injectCapabilities(
  middleware: readonly KoiMiddleware[],
  ctx: TurnContext,
  request: ModelRequest,
  config?: CapabilityInjectionConfig,
): ModelRequest
```

### Config (L1)

```typescript
interface CapabilityInjectionConfig {
  readonly maxCapabilityTokens?: number; // default: unlimited
}
```

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────────┐
    CapabilityFragment (interface only)                      │
    KoiMiddleware.describeCapabilities (required hook)       │
    Zero function bodies, zero imports                       │
                                                             │
L1  @koi/engine ◄────────────────────────────────────────────┘
    collectCapabilities, formatCapabilityMessage,
    injectCapabilities (runtime logic)
    koi.ts prepareRequest (wired into callHandlers)
    Imports: @koi/core only

L2  25 middleware packages + forge + identity + context ◄── L0 only
    Each implements describeCapabilities (required)
    Zero imports from @koi/engine or peer L2 packages
```

---

## Examples

### Basic Usage

```typescript
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createPayMiddleware } from "@koi/middleware-pay";
import { createPermissionsMiddleware } from "@koi/middleware-permissions";

const runtime = await createKoi({
  manifest: { name: "my-agent", version: "1.0.0", model: { name: "claude-haiku-4-5" } },
  adapter: createPiAdapter({
    model: "anthropic:claude-haiku-4-5-20251001",
    getApiKey: async () => process.env.ANTHROPIC_API_KEY,
  }),
  middleware: [
    createPayMiddleware({ maxBudget: 10000 }),
    createPermissionsMiddleware({
      engine: createPatternPermissionEngine(),
      rules: { allow: ["*"], deny: [], ask: ["deploy_prod"] },
    }),
  ],
});

// The LLM now sees:
//   [Active Capabilities]
//   - **permissions**: Tools requiring approval: deploy_prod. Default: allow
//   - **budget**: Token budget: 10,000 of 10,000 remaining
```

### Custom Middleware with describeCapabilities

```typescript
import type { CapabilityFragment, KoiMiddleware, TurnContext } from "@koi/core";

function createRateLimiter(maxPerMinute: number): KoiMiddleware {
  const fragment: CapabilityFragment = {
    label: "rate-limit",
    description: `Max ${maxPerMinute} tool calls per minute`,
  };
  return {
    name: "custom-rate-limiter",
    priority: 150,
    describeCapabilities: () => fragment,
    wrapToolCall: async (ctx, request, next) => {
      // ... rate limiting logic ...
      return next(request);
    },
  };
}
```

### Observing Injected Capabilities (Testing)

```typescript
const captured: ModelRequest[] = [];

const spy: KoiMiddleware = {
  name: "request-spy",
  priority: 999,
  wrapModelStream: (ctx, request, next) => {
    captured.push(request);
    return next(request);
  },
};

const runtime = await createKoi({
  manifest,
  adapter,
  middleware: [myMiddleware, spy],
});

// After running:
const capMsg = captured[0]?.messages.find(m => m.senderId === "system:capabilities");
// capMsg.content[0].text === "[Active Capabilities]\n- **my-label**: my description"
```

---

## Migration: `describeCapabilities` is Now Required

As of Issue #515, `describeCapabilities` is a **required** property on `KoiMiddleware`. Previously it was optional.

### What Changed

- `describeCapabilities` is no longer optional (`?` removed from the interface)
- The return type remains `CapabilityFragment | undefined` — return `undefined` to skip injection
- TypeScript enforces this at compile time
- `createKoi()` emits a runtime warning for JS consumers that omit it

### How to Migrate

Add `describeCapabilities` to any middleware that doesn't have it:

```typescript
// Middleware with nothing to describe:
describeCapabilities: () => undefined,

// Middleware with a static description:
describeCapabilities: () => ({
  label: "my-middleware",
  description: "What this middleware does",
}),
```
