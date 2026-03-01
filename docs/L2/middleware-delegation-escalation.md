# @koi/middleware-delegation-escalation — Human Escalation When All Delegatees Are Down

When every delegatee's circuit breaker is open, pauses the engine loop and asks a human for instructions via the bidirectional channel contract. The human can resume with guidance or abort cleanly. Connects three existing building blocks — delegation circuit breakers, the channel contract, and the `hitl_pause` lifecycle state — into a single escalation path.

---

## Why It Exists

When a supervisor agent delegates to multiple workers and all of them fail past their circuit breaker thresholds, the system has a dead end:

1. **No fallback path.** The supervisor cannot delegate work — all circuits are open. Without escalation, it either aborts silently or enters an infinite retry loop.
2. **Humans are not in the loop.** The `hitl_pause` and `human_approval` lifecycle states exist in L0, but nothing wires them to the delegation subsystem. A human operator has no way to know the system is stuck.
3. **Context is lost on abort.** If the supervisor self-terminates, the human has to restart from scratch. By pausing instead of aborting, the in-flight state is preserved and the human can steer the agent forward.

This middleware closes the gap:

- **Detects exhaustion** — checks if all monitored delegatees have open circuit breakers
- **Sends a human-readable message** — via the channel (Slack, CLI, Discord, etc.) with the list of failed workers and optional task summary
- **Pauses the engine** — the `for await` loop naturally suspends while `wrapModelCall` awaits the human response
- **Resumes or aborts** — based on the human's reply, injects instructions into the next model call or throws to halt the engine

---

## Architecture

`@koi/middleware-delegation-escalation` is an **L2 feature package** — it depends only on L0 (`@koi/core`). It does NOT import from `@koi/delegation` (peer L2). Instead, the consumer wires a `() => boolean` callback for the exhaustion check.

```
┌──────────────────────────────────────────────────────────────┐
│  @koi/middleware-delegation-escalation  (L2)                  │
│                                                              │
│  types.ts              ← Config, EscalationDecision, consts  │
│  escalation-message.ts ← Pure message formatter              │
│  escalation-gate.ts    ← Promise-based pause mechanism       │
│  middleware.ts         ← Middleware factory + state           │
│  index.ts              ← Public API surface                  │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  Dependencies                                                │
│                                                              │
│  @koi/core   (L0)   KoiMiddleware, ChannelAdapter,           │
│                      OutboundMessage, InboundMessage,         │
│                      AgentId, DelegationEvent, TurnContext    │
└──────────────────────────────────────────────────────────────┘
```

### Layer Decoupling

The middleware never imports `@koi/delegation`. The exhaustion check is a callback:

```
┌─────────────────┐         ┌──────────────────────────────┐
│ @koi/delegation  │         │ @koi/middleware-delegation-   │
│ (peer L2)        │         │ escalation (this package)    │
│                  │         │                              │
│ manager          │         │ config.isExhausted           │
│  .isExhausted()──┼────────▶│  = () => boolean             │
│                  │  wired  │                              │
│                  │  by     │ config.onExhausted           │
│ manager          │  consumer│  = (event) => void          │
│  .onEvent?.()   ◀┼─────────│                              │
└─────────────────┘         └──────────────────────────────┘
```

No L2-to-L2 import. The consumer (L3 or application code) wires the two packages together.

---

## How It Works

### Full Escalation Flow

```
     Engine loop (for await)
            │
            ▼
   ┌────────────────────┐
   │    onAfterTurn()    │
   │                     │
   │  isExhausted()?     │
   │    no  → return     │
   │    yes → arm gate   │
   └────────┬───────────┘
            │
            ▼
   ┌────────────────────┐        ┌─────────────────┐
   │  Emit delegation:   │        │                 │
   │  exhausted event    │        │  Channel        │
   │                     │────────▶  (Slack/CLI/    │
   │  Send escalation    │        │   Discord)      │
   │  message via channel│        │                 │
   └────────┬───────────┘        └────────┬────────┘
            │                             │
            ▼                             │
   ┌────────────────────┐                 │
   │  wrapModelCall()    │                 ▼
   │                     │        ┌─────────────────┐
   │  Gate is pending    │        │  Human Operator  │
   │  → await gate       │        │                 │
   │                     │        │  Sees message:  │
   │     ⏸ PAUSED        │        │  "All workers   │
   │                     │        │   exhausted"    │
   │                     │◀───────│                 │
   │  Decision received  │        │  Types reply    │
   └────────┬───────────┘        └─────────────────┘
            │
       ┌────┴────┐
       │         │
   "abort"    anything else
       │         │
       ▼         ▼
   ┌────────┐ ┌──────────────────┐
   │ throws │ │ Inject instruction│
   │ Error  │ │ into ModelRequest │
   │        │ │ messages[]        │
   │ Engine │ │                  │
   │ halts  │ │ next(modified)   │
   └────────┘ │ Engine resumes   │
              └──────────────────┘
```

### Suspension Mechanism

The engine's `for await` loop is **naturally paused** while `wrapModelCall` awaits the gate promise. No external lifecycle mutations — no registry transitions, no timers polling for state. The middleware simply holds the promise until:

1. A human message arrives on the channel → resolves as `resume`
2. The timeout expires (default: 10 minutes) → resolves as `abort`
3. The AbortSignal fires → resolves as `abort`
4. `handle.cancel()` is called → resolves as `abort`

### Middleware Position (Onion)

```
               Incoming Model Call
                      │
                      ▼
          ┌───────────────────────┐
          │   middleware-audit     │  priority: 450
          ├───────────────────────┤
          │  middleware-guided-    │  priority: 425
          │  retry                │
          ├───────────────────────┤
          │  middleware-semantic-  │  priority: 420
          │  retry                │
          ├───────────────────────┤
          │  middleware-permissions│  priority: 400
          ├───────────────────────┤
       ┌──│  middleware-delegation-│──┐  priority: 300
       │  │  escalation (THIS)    │  │
       │  ├───────────────────────┤  │
       │  │  engine adapter       │  │
       │  │  → LLM API call       │  │
       │  └───────────┬───────────┘  │
       │         Response            │
       │              │              │
       │   ┌──────────▼──────────┐   │
       └──▶│ If gate pending:    │◀──┘
           │  await human reply  │
           │  inject instruction │
           └─────────────────────┘
```

Priority 300 places it **before** semantic-retry (420) in the onion. This means:

- On the way **in**, the escalation middleware wraps first — if the gate is pending, it pauses before the model call reaches the retry layer
- On the way **out**, retries happen before escalation is checked — the system exhausts retry budgets before escalating to a human

---

## Escalation Gate

The gate is a promise-based pause mechanism that races three signals:

```
┌──────────────────────────────────────────┐
│  EscalationGate                          │
│                                          │
│  ┌──────────────┐  ┌──────────────────┐  │
│  │ channel       │  │ setTimeout       │  │
│  │ .onMessage()  │  │ (10 min default) │  │
│  └──────┬───────┘  └───────┬──────────┘  │
│         │                  │             │
│         │  ┌───────────────┤             │
│         │  │ AbortSignal   │             │
│         │  └───────┬───────┘             │
│         │          │                     │
│         ▼          ▼                     │
│     Promise.race (first to resolve wins) │
│         │                                │
│         ▼                                │
│   EscalationDecision                     │
│   { kind: "resume", instruction? }       │
│   { kind: "abort", reason }              │
└──────────────────────────────────────────┘
```

Cleanup is thorough: on resolution, the channel listener is unsubscribed, the timer is cleared, and the AbortSignal listener is removed. No resource leaks.

### Response Parsing

| Human types | Decision |
|-------------|----------|
| `abort` (case-insensitive, trimmed) | `{ kind: "abort", reason: "Human operator requested abort" }` |
| Anything else | `{ kind: "resume", instruction: "<their text>" }` |
| (no text blocks in message) | `{ kind: "resume" }` (no instruction) |
| (timeout expires) | `{ kind: "abort", reason: "Escalation timed out after 600000ms" }` |

---

## Hot Path Performance

The middleware adds near-zero overhead when delegatees are healthy:

```
onAfterTurn(ctx):
  │
  ├── isExhausted()?         ← 1 callback (sync)
  │     false → return       ← fast path, zero allocations
  │     true  → arm gate     ← only on exhaustion

wrapModelCall(ctx, request, next):
  │
  ├── gate pending?          ← 1 undefined check
  │     no  → next(request)  ← straight through
  │     yes → await gate     ← only when escalating
```

**Success path:** 1 boolean check per turn + 1 undefined check per model call. Zero allocations, zero async operations.

**Escalation path:** 1 channel.send() + 1 promise allocation + 1 channel listener. Bounded by a single gate (double-arm prevention ensures only one gate exists at a time).

---

## API Reference

### Factory Functions

#### `createDelegationEscalationMiddleware(config)`

Creates the middleware with escalation state management.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `config.channel` | `ChannelAdapter` | (required) | Bidirectional channel for human communication |
| `config.isExhausted` | `() => boolean` | (required) | Returns true when all delegates are exhausted |
| `config.issuerId` | `AgentId` | (required) | The owning agent's ID |
| `config.monitoredDelegateeIds` | `readonly AgentId[]` | (required) | Delegatee IDs for the event payload |
| `config.taskSummary` | `string` | — | Optional context for the escalation message |
| `config.escalationTimeoutMs` | `number` | `600_000` | Timeout waiting for human response (10 min) |
| `config.onEscalation` | `(decision) => void` | — | Fires when a human decision is received |
| `config.onExhausted` | `(event) => void` | — | Fires when exhaustion is detected (emits event) |

**Returns:** `DelegationEscalationHandle`

```typescript
interface DelegationEscalationHandle {
  readonly middleware: KoiMiddleware    // Register in your agent
  readonly isPending: () => boolean    // True while awaiting human
  readonly cancel: () => void          // Force-abort the pending gate
}
```

#### `createEscalationGate(channel, signal?, timeoutMs?)`

Low-level: creates a promise that resolves on the next channel message, timeout, or signal abort. Used internally by the middleware, exposed for advanced use cases.

#### `generateEscalationMessage(ctx)`

Pure function that formats a human-readable `OutboundMessage` from an `EscalationContext`. Includes delegatee list and optional task summary.

#### `parseHumanResponse(message)`

Pure function that maps an `InboundMessage` to an `EscalationDecision`. `"abort"` (case-insensitive) → abort, anything else → resume.

### Types

| Type | Description |
|------|-------------|
| `EscalationContext` | `{ issuerId, exhaustedDelegateeIds, detectedAt, taskSummary? }` |
| `EscalationDecision` | `{ kind: "resume", instruction? } \| { kind: "abort", reason }` |
| `DelegationEscalationConfig` | Configuration for the middleware factory |
| `DelegationEscalationHandle` | Return type with middleware + state accessors |
| `EscalationGate` | `{ promise, isPending(), cancel() }` |

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_ESCALATION_TIMEOUT_MS` | `600_000` | 10 minutes |

---

## Examples

### Basic Usage

```typescript
import { createDelegationEscalationMiddleware } from "@koi/middleware-delegation-escalation";
import { createDelegationManager } from "@koi/delegation";

const manager = createDelegationManager({ config });

const { middleware } = createDelegationEscalationMiddleware({
  channel: mySlackChannel,
  isExhausted: () => manager.isExhausted([agentId("w1"), agentId("w2")]),
  issuerId: agentId("orchestrator"),
  monitoredDelegateeIds: [agentId("w1"), agentId("w2")],
});

// Register in your Koi agent assembly:
const agent = await createKoi({
  manifest,
  middleware: [middleware],
});
```

### With Observability and Event Emission

```typescript
const { middleware, isPending } = createDelegationEscalationMiddleware({
  channel: myChannel,
  isExhausted: () => manager.isExhausted(workerIds),
  issuerId: agentId("orchestrator"),
  monitoredDelegateeIds: workerIds,
  taskSummary: "Processing batch import of 10k user records",
  escalationTimeoutMs: 300_000,  // 5 minutes

  onExhausted(event) {
    // Feed event to the delegation manager's event bus
    manager.onEvent?.(event);
    // Log for monitoring
    logger.warn("delegation-exhausted", { event });
  },

  onEscalation(decision) {
    metrics.increment("escalation.decision", { kind: decision.kind });
    if (decision.kind === "resume") {
      logger.info("human-resumed", { instruction: decision.instruction });
    }
  },
});

// Check escalation status from a health endpoint:
app.get("/health", () => ({
  escalationPending: isPending(),
}));
```

### With Lifecycle Transitions

```typescript
const { middleware } = createDelegationEscalationMiddleware({
  channel: myChannel,
  isExhausted: () => manager.isExhausted(workerIds),
  issuerId: agentId("orchestrator"),
  monitoredDelegateeIds: workerIds,

  onExhausted(event) {
    // Transition agent to suspended state for dashboard visibility
    registry.transition(
      agentId("orchestrator"),
      "suspended",
      currentGeneration,
      { kind: "hitl_pause" },
    );
  },

  onEscalation(decision) {
    if (decision.kind === "resume") {
      // Transition back to running
      registry.transition(
        agentId("orchestrator"),
        "running",
        currentGeneration,
        { kind: "human_approval" },
      );
    }
  },
});
```

### With Other Middleware

```typescript
import { createSemanticRetryMiddleware } from "@koi/middleware-semantic-retry";
import { createDelegationEscalationMiddleware } from "@koi/middleware-delegation-escalation";
import { createAuditMiddleware } from "@koi/middleware-audit";

const agent = await createKoi({
  manifest,
  middleware: [
    createAuditMiddleware({ ... }),                          // priority: 450
    createSemanticRetryMiddleware({ ... }).middleware,        // priority: 420
    createDelegationEscalationMiddleware({ ... }).middleware, // priority: 300
  ],
});
// Retries exhaust first → then escalation pauses → human decides
```

### Cancel from External Code

```typescript
const handle = createDelegationEscalationMiddleware({ ... });

// If the supervisor is being shut down externally:
process.on("SIGTERM", () => {
  handle.cancel();  // Resolves the gate as abort
});
```

---

## End-to-End Flow Example

```
User: "Deploy v2 to all 3 regions"
         │
         ▼
┌────────────────────────┐
│  Supervisor Agent       │
│  Delegates to 3 workers │
└────────┬───────────────┘
         │
    ┌────┴────┬──────────┐
    ▼         ▼          ▼
 Worker     Worker     Worker
 us-east    eu-west    ap-south
    │         │          │
  ✓ OK     ✗ FAIL     ✗ FAIL
            (5x)       (5x)
              │          │
              ▼          ▼
         [circuit]  [circuit]
         [  open ]  [  open ]

         (isExhausted? → partial: false)
         │
         ▼
  us-east completes, but fails on retry for eu-west
         │
       ✗ FAIL (5x)
         │
         ▼
    [circuit open]

    isExhausted([eu-west, ap-south]) → true
         │
    ┌────▼───────────────────────────────┐
    │  Escalation Middleware              │
    │                                    │
    │  1. Emit delegation:exhausted      │
    │  2. Send to Slack:                 │
    │                                    │
    │  ┌────────────────────────────┐    │
    │  │ :warning: All delegatees   │    │
    │  │ for "supervisor" exhausted │    │
    │  │                            │    │
    │  │ Exhausted:                 │    │
    │  │   - eu-west                │    │
    │  │   - ap-south               │    │
    │  │                            │    │
    │  │ Task: Deploy v2 to all     │    │
    │  │ 3 regions                  │    │
    │  │                            │    │
    │  │ Reply to resume or         │    │
    │  │ type "abort"               │    │
    │  └────────────────────────────┘    │
    │                                    │
    │  3. Engine PAUSED (awaiting)       │
    └────────────────────┬───────────────┘
                         │
                         ▼
    ┌────────────────────────────────────┐
    │  DevOps Engineer (in Slack):       │
    │                                    │
    │  "eu-west had a region outage,     │
    │   skip it and deploy ap-south      │
    │   using the backup endpoint"       │
    └────────────────────┬───────────────┘
                         │
                         ▼
    ┌────────────────────────────────────┐
    │  Engine RESUMES                    │
    │                                    │
    │  Next model call includes:         │
    │  "[Human escalation instruction]   │
    │   eu-west had a region outage,     │
    │   skip it and deploy ap-south      │
    │   using the backup endpoint"       │
    │                                    │
    │  Supervisor adjusts strategy →     │
    │  deploys ap-south via backup →     │
    │  reports success                   │
    └────────────────────────────────────┘
```

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────────┐
    KoiMiddleware, ChannelAdapter, AgentId,                  │
    DelegationEvent, OutboundMessage, InboundMessage,        │
    TurnContext, CapabilityFragment                           │
                                                              │
                                                              ▼
L2  @koi/middleware-delegation-escalation ◄──────────────────┘
    imports from L0 only
    ✗ never imports @koi/engine (L1)
    ✗ never imports @koi/delegation (peer L2)
    ✗ zero external dependencies
```

**Dev-only dependency** (`@koi/test-utils`) is used in tests but is not a runtime import.

The consumer wires `@koi/delegation` to this middleware via the `isExhausted` callback — composition at the application layer, not a compile-time dependency.
