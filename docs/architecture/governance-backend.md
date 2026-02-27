# GovernanceBackend — Pluggable Rule-Based Policy Evaluation Contract (L0)

A canonical L0 interface for evaluating policy requests, checking constraints, recording compliance, and querying violation history. Backend implementations are swappable — in-memory for dev/test, OPA or Cedar for production — with zero changes to consumers.

**Layer**: L0 types (`@koi/core`)
**Issue**: #265

---

## Why It Exists

Koi already has a GovernanceController (#261) for numeric guardrails — turns, tokens, cost, spawn depth. But numeric gauges can't answer *policy* questions:

```
GovernanceController (numeric)       GovernanceBackend (rule-based)
──────────────────────────────       ─────────────────────────────

"Has this agent used 25 turns?"      "Can this agent call execute_sql?"
"Is token budget exhausted?"         "Is this model call allowed by org policy?"
"Is spawn depth too deep?"           "Should we block delegation to untrusted agents?"
                                     "Log every allow/deny for SOC2 audit"
                                     "Show all critical violations in the last hour"
```

They are **parallel peers** — both attached to the same agent, both active simultaneously, each handling a different governance dimension:

| Dimension | GovernanceController | GovernanceBackend |
|-----------|---------------------|-------------------|
| What it checks | Numeric gauges (turns, tokens, cost) | Rule-based policies (tool access, model permissions) |
| Decision type | Threshold comparison (current >= limit?) | Rich verdict (allow/deny with violations) |
| Audit trail | Snapshot of sensor readings | Compliance records with policy fingerprint |
| Extensibility | L2 contributes numeric variables | L2 implements policy engines (OPA, Cedar) |
| ECS token | `GOVERNANCE` | `GOVERNANCE_BACKEND` |

---

## Layer Position

```
L0  @koi/core
    └── GovernanceBackend            ← composite interface (this doc)
        PolicyEvaluator              ← evaluate PolicyRequest → GovernanceVerdict
        ConstraintChecker            ← check individual constraints
        ComplianceRecorder           ← audit trail recording
        ViolationStore               ← violation history queries
        PolicyRequest                ← input shape
        GovernanceVerdict            ← output shape (ok: true | ok: false + violations)
        Violation                    ← rule + severity + message
        ViolationSeverity            ← "info" | "warning" | "critical"
        ComplianceRecord             ← request + verdict + policy fingerprint
        GOVERNANCE_ALLOW             ← frozen singleton allow verdict
        VIOLATION_SEVERITY_ORDER     ← frozen ordered array
        DEFAULT_VIOLATION_QUERY_LIMIT ← 100
        GOVERNANCE_BACKEND           ← ECS token (in ecs.ts)

L2  @koi/governance-memory (future)
    └── implements GovernanceBackend
    └── in-memory rule engine, sync, dev/test

L2  @koi/governance-opa (future)
    └── implements GovernanceBackend
    └── OPA Rego policies, async HTTP, production

L2  @koi/governance-cedar (future)
    └── implements GovernanceBackend
    └── Cedar policies, local engine, production
```

`@koi/core` has zero dependencies. `GovernanceBackend` imports only from `./common.js` and `./ecs.js`.

---

## Architecture

### The contract surface (ISP split)

```
GovernanceBackend
│
├── evaluator (required)     PolicyEvaluator
│   ├── evaluate(request)    PolicyRequest → GovernanceVerdict
│   └── scope?               PolicyRequestKind[] — hot-path filter
│
├── constraints? (optional)  ConstraintChecker
│   └── checkConstraint(q)   ConstraintQuery → boolean
│
├── compliance? (optional)   ComplianceRecorder
│   └── recordCompliance(r)  ComplianceRecord → ComplianceRecord
│
├── violations? (optional)   ViolationStore
│   └── getViolations(f)     ViolationFilter → ViolationPage
│
└── dispose?()               optional cleanup
```

The interface follows the **Interface Segregation Principle** — only the evaluator is required. Backends that don't need compliance recording or violation history simply omit those sub-interfaces. Consumers check for presence before calling.

### Fail-closed contract

When `evaluate()` throws or returns an error, callers **must deny access**. A missing or errored backend means "deny all":

```
evaluate(request) → verdict.ok === true   → allow
evaluate(request) → verdict.ok === false  → deny (violations attached)
evaluate(request) → throws                → deny (fail-closed)
backend is undefined                      → deny (fail-closed)
```

### PolicyRequest → GovernanceVerdict flow

```
  Middleware receives model/tool call
      │
      ▼
  Construct PolicyRequest:
  ┌──────────────────────────────────┐
  │ kind: "model_call"               │
  │ agentId: "agent-worker-42"       │
  │ payload: { model: "claude-sonnet"│
  │            prompt: "..." }       │
  │ timestamp: 1709049600000         │
  └──────────────────────────────────┘
      │
      ▼
  Scope check: is "model_call" in evaluator.scope?
      │
      ├── scope defined and kind NOT in scope → skip (allow)
      │
      └── scope undefined OR kind in scope → evaluate
          │
          ▼
  evaluator.evaluate(request)
          │
          ▼
  ┌────────────────────────────────────┐
  │ GovernanceVerdict                   │
  │                                    │
  │ ok: true                           │  → allow, proceed
  │   diagnostics?: [{ info: "..." }]  │    (optional warnings)
  │                                    │
  │ ok: false                          │  → deny
  │   violations: [                    │
  │     { rule: "no-destructive-sql",  │
  │       severity: "critical",        │
  │       message: "DROP not allowed"  │
  │       context: { table: "users" }  │
  │     }                              │
  │   ]                                │
  └────────────────────────────────────┘
```

### Scope filter (hot-path optimization)

The `evaluator.scope` field is a performance optimization. When present, the middleware chain can skip evaluating requests whose `kind` doesn't match:

```
evaluator.scope = ["tool_call", "spawn"]

model_call request  → NOT in scope → skip evaluate() → allow  (saves ~1 RPC)
tool_call request   → in scope     → evaluate()
spawn request       → in scope     → evaluate()
```

When `scope` is absent or undefined, the evaluator handles all request kinds.

---

## Data Flow

### Allow path (middleware integration)

```
  User prompt: "What's the weather?"
      │
      ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  Governance Backend Middleware (wrapModelStream / wrapModelCall)
  │                                                              │
  │  1. Build PolicyRequest { kind: "model_call", agentId, ... } │
  │                                                              │
  │  2. Scope check — kind in evaluator.scope?                   │
  │     yes: evaluate(request) → { ok: true } ✓                  │
  │                                                              │
  │  3. checkConstraint? { kind: "spawn_depth", value: 2 }       │
  │     → true ✓                                                 │
  │                                                              │
  │  4. Forward to next middleware → model call executes          │
  │                                                              │
  │  5. recordCompliance? {                                      │
  │       requestId: "req-abc123",                               │
  │       request: <original PolicyRequest>,                     │
  │       verdict: { ok: true },                                 │
  │       evaluatedAt: 1709049600000,                            │
  │       policyFingerprint: "sha256:abc..."                     │
  │     }                                                        │
  └──────────────────────────────────────────────────────────────┘
      │
      ▼
  LLM response: "The weather is sunny..."
```

### Deny path (fail-closed enforcement)

```
  Agent "data-analyst" tries tool "execute_sql":
      │
      ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  Governance Backend Middleware (wrapToolCall)                  │
  │                                                              │
  │  1. Build PolicyRequest:                                     │
  │     kind: "tool_call"                                        │
  │     agentId: "data-analyst"                                  │
  │     payload: { tool: "execute_sql", args: { sql: "DROP.." }} │
  │                                                              │
  │  2. evaluate(request) →                                      │
  │     {                                                        │
  │       ok: false,                                             │
  │       violations: [{                                         │
  │         rule: "no-destructive-sql",                          │
  │         severity: "critical",                                │
  │         message: "DROP not allowed for non-admin agents"     │
  │       }]                                                     │
  │     }                                                        │
  │                                                              │
  │  3. DENY — throw KoiRuntimeError(PERMISSION, "...")          │
  │     Tool never executes.                                     │
  │     Violation recorded in compliance log.                    │
  └──────────────────────────────────────────────────────────────┘
```

### Both governance systems active simultaneously

```
  ┌─────────────────────────────────────────────────────────┐
  │                    Agent (ECS Entity)                     │
  │                                                          │
  │  ┌──────────────────┐     ┌───────────────────────────┐  │
  │  │   GOVERNANCE      │     │   GOVERNANCE_BACKEND       │  │
  │  │   (Controller)    │     │   (Rule Engine)            │  │
  │  │                   │     │                            │  │
  │  │   turns: 3/25     │     │   evaluator ──► OPA/Cedar  │  │
  │  │   tokens: 12k/100k│     │   constraints? ──► limits  │  │
  │  │   cost: $0.02/$1  │     │   compliance? ──► audit    │  │
  │  │   errors: 0.1/0.5 │     │   violations? ──► history  │  │
  │  │   depth: 1/5      │     │                            │  │
  │  └──────────────────┘     └───────────────────────────┘  │
  │      │  parallel peers, both active  │                   │
  └──────┼───────────────────────────────┼───────────────────┘
         │                               │
         ▼                               ▼
  ┌──────────────────────────────────────────────────────────┐
  │                 Middleware Chain                           │
  │                                                          │
  │  governance-guard (p:0)      ← Controller: checkAll()    │
  │  governance-backend-mw (p:X) ← Backend: evaluate()       │
  │  ... other middleware ...                                │
  └──────────────────────────────────────────────────────────┘
         │
         ▼
  ┌──────────────────────┐
  │   Engine Adapter      │
  └──────────────────────┘
```

---

## Wiring

### Via ComponentProvider + createKoi

GovernanceBackend is attached to the agent via a `ComponentProvider`, the same pattern as all ECS components:

```typescript
import type { ComponentProvider, GovernanceBackend } from "@koi/core";
import { COMPONENT_PRIORITY, GOVERNANCE_BACKEND } from "@koi/core";

// 1. Create the backend
const backend: GovernanceBackend = createMyGovernanceBackend(config);

// 2. Wrap it in a ComponentProvider
const provider: ComponentProvider = {
  name: "governance-backend-provider",
  priority: COMPONENT_PRIORITY.BUNDLED,
  attach: async () => new Map([[GOVERNANCE_BACKEND, backend]]),
};

// 3. Pass to createKoi
const runtime = await createKoi({
  manifest: { name: "my-agent", version: "1.0.0", model: { name: "claude-sonnet" } },
  adapter: myAdapter,
  providers: [provider],
  middleware: [createGovernanceBackendMiddleware(backend)],
});
```

### Middleware pattern (closure capture)

The middleware receives the backend at construction time via closure — **not** from `TurnContext` (which doesn't carry the agent entity):

```typescript
function createGovernanceBackendMiddleware(
  backend: GovernanceBackend,
): KoiMiddleware {
  return {
    name: "governance-backend",
    priority: 100,

    // For streaming adapters (Pi adapter)
    async *wrapModelStream(ctx, request, next) {
      const policyRequest: PolicyRequest = {
        kind: "model_call",
        agentId: agentId(ctx.session.agentId),
        payload: { model: request.model },
        timestamp: Date.now(),
      };

      // Scope check
      if (backend.evaluator.scope !== undefined) {
        if (!backend.evaluator.scope.includes("model_call")) {
          yield* next(request);
          return;
        }
      }

      // Evaluate
      const verdict = await backend.evaluator.evaluate(policyRequest);
      if (!verdict.ok) {
        throw new Error(`Policy denied: ${verdict.violations[0].message}`);
      }

      // Forward
      try {
        yield* next(request);
      } finally {
        // Record compliance (finally survives generator .return())
        if (backend.compliance !== undefined) {
          await backend.compliance.recordCompliance({
            requestId: `req-${Date.now()}`,
            request: policyRequest,
            verdict,
            evaluatedAt: Date.now(),
            policyFingerprint: "sha256:...",
          });
        }
      }
    },

    // For non-streaming adapters (Loop adapter)
    async wrapModelCall(ctx, request, next) {
      // Same pattern as wrapModelStream
      const verdict = await backend.evaluator.evaluate(/* ... */);
      if (!verdict.ok) throw new Error(/* ... */);
      const response = await next(request);
      // recordCompliance...
      return response;
    },
  };
}
```

---

## Adapter-Specific Behavior

### Loop adapter vs Pi adapter

The governance middleware must handle both streaming and non-streaming adapters:

| Aspect | Loop Adapter | Pi Adapter |
|--------|-------------|------------|
| Model call path | `wrapModelCall` | `wrapModelStream` |
| Return type | `Promise<ModelResponse>` | `AsyncIterable<ModelChunk>` |
| Deny enforcement | Throw in `wrapModelCall` | Throw in `onBeforeTurn` |
| Compliance recording | After `await next()` | In `try/finally` block |

### Pi adapter gotchas

1. **Errors in `wrapModelStream` are non-fatal**: The stream bridge catches errors from async generators and converts them to pi-agent-core error events. The PiAgent completes with `stopReason: "completed"` despite the error. **Solution**: Use `onBeforeTurn` for deny enforcement — koi.ts properly propagates `KoiRuntimeError` to a done event with `stopReason: "error"`.

2. **Generator early termination**: The stream bridge calls `.return()` on the async generator when it processes a `done` chunk. Code after `yield*` never executes. **Solution**: Use `try/finally` for compliance recording.

3. **Async race on deny**: Pi adapter starts `piAgent.prompt()` asynchronously before `onBeforeTurn` fires, so `getApiKey` may be called even when deny blocks the turn. This is expected — the deny still prevents any model output.

---

## L0 Types (`@koi/core/governance-backend.ts`)

### PolicyRequestKind

```typescript
type PolicyRequestKind =
  | "tool_call"
  | "model_call"
  | "spawn"
  | "delegation"
  | "forge"
  | "handoff"
  | `custom:${string}`;  // domain-specific extensions
```

### PolicyRequest

```typescript
interface PolicyRequest {
  readonly kind: PolicyRequestKind;
  readonly agentId: AgentId;
  readonly payload: JsonObject;
  readonly timestamp: number;  // Unix ms
}
```

### GovernanceVerdict

Discriminated union on `ok`:

```typescript
type GovernanceVerdict =
  | { readonly ok: true; readonly diagnostics?: readonly Violation[] }
  | { readonly ok: false; readonly violations: readonly Violation[] };
```

`GOVERNANCE_ALLOW` is a frozen singleton for the common allow case — avoids allocating a new object per decision.

### Violation

```typescript
interface Violation {
  readonly rule: string;               // e.g., "no-destructive-sql"
  readonly severity: ViolationSeverity; // "info" | "warning" | "critical"
  readonly message: string;
  readonly context?: JsonObject;
}
```

### ViolationSeverity

Three levels, ordered least to most severe:

```
VIOLATION_SEVERITY_ORDER = ["info", "warning", "critical"]
```

Use the array for comparisons:

```typescript
const idx = VIOLATION_SEVERITY_ORDER.indexOf(violation.severity);
if (idx >= VIOLATION_SEVERITY_ORDER.indexOf("warning")) {
  // warning or critical
}
```

### ComplianceRecord

Links a request to its verdict for audit:

```typescript
interface ComplianceRecord {
  readonly requestId: string;
  readonly request: PolicyRequest;
  readonly verdict: GovernanceVerdict;
  readonly evaluatedAt: number;           // Unix ms
  readonly policyFingerprint: string;     // reproducibility
}
```

### ViolationFilter + ViolationPage

```typescript
interface ViolationFilter {
  readonly agentId?: AgentId;
  readonly sessionId?: SessionId;
  readonly severity?: ViolationSeverity;  // at or above this level
  readonly rule?: string;
  readonly since?: number;
  readonly until?: number;
  readonly limit?: number;      // default: DEFAULT_VIOLATION_QUERY_LIMIT (100)
  readonly offset?: string;     // opaque pagination cursor
}

interface ViolationPage {
  readonly items: readonly Violation[];
  readonly cursor?: string;     // next page cursor
  readonly total?: number;      // if backend supports it
}
```

---

## Sub-Interfaces (ISP)

| Sub-Interface | Required | Methods | Purpose |
|---------------|----------|---------|---------|
| `PolicyEvaluator` | yes | `evaluate(request)`, `scope?` | Core policy decision |
| `ConstraintChecker` | no | `checkConstraint(query)` | Individual limit checks |
| `ComplianceRecorder` | no | `recordCompliance(record)` | Audit trail |
| `ViolationStore` | no | `getViolations(filter)` | Violation history queries |

All methods return `T | Promise<T>` — in-memory backends are sync, HTTP/database backends are async.

---

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| ISP split | 4 sub-interfaces | Backends implement only what they need. An OPA evaluator doesn't need violation storage |
| Fail-closed | Callers must deny on error | Security-first — ambiguous state = deny |
| `GOVERNANCE_ALLOW` singleton | Frozen, reused | Avoids allocation per decision on the hot path |
| Scope filter | Optional `PolicyRequestKind[]` | Hot-path optimization — skip eval for irrelevant kinds |
| Parallel to Controller | Separate ECS token | Each handles a different governance dimension without coupling |
| `custom:${string}` kind | Template literal type | Domain extensions without modifying the core union |
| Compliance fingerprint | String (opaque) | Reproducibility — tie verdict to exact policy version |
| Violation severity | 3-level scale + ordered array | Simple, covers real needs, canonical ordering for comparisons |

---

## Comparison: GovernanceController vs GovernanceBackend

```
                  GovernanceController           GovernanceBackend
                  ────────────────────           ─────────────────

ECS token:        GOVERNANCE                     GOVERNANCE_BACKEND

Question type:    "How much?"                    "Is this allowed?"
                  (numeric gauges)               (rule-based policies)

Input:            GovernanceEvent                PolicyRequest
                  { kind: "turn" }               { kind: "tool_call",
                  { kind: "token_usage",           agentId, payload }
                    count: 1200 }

Output:           GovernanceCheck                GovernanceVerdict
                  { ok: false,                   { ok: false,
                    variable: "turn_count",        violations: [
                    reason: "limit reached" }        { rule: "no-sql-drop",
                                                       severity: "critical",
                                                       message: "..." }
                                                   ] }

Audit:            snapshot() → sensor readings   recordCompliance() → full record
                                                 getViolations() → history

Extensibility:    L2 contributes numeric vars    L2 implements policy engines
                  via GovernanceVariableContributor  (OPA, Cedar, custom rules)

Wiring:           Built into createKoi           Via ComponentProvider + middleware
                  governance option               providers option + middleware option
```

Both are active simultaneously. Neither subsumes the other.

---

## Future Backend Implementations

```
@koi/core (L0)
└── GovernanceBackend ← this contract

@koi/governance-memory (L2, planned)
└── in-memory rule engine
└── configurable rule functions
└── sync — zero async overhead
└── use for: dev, test, single-node

@koi/governance-opa (L2, planned)
└── OPA Rego policies
└── HTTP → OPA sidecar/service
└── async — network I/O
└── use for: production, Kubernetes

@koi/governance-cedar (L2, planned)
└── Cedar policies (AWS-style RBAC/ABAC)
└── local WASM engine
└── sync or async depending on policy store
└── use for: production, fine-grained authz
```

Consumers code against `GovernanceBackend` — switching backends is a one-line change at the composition root.

---

## Testing

### Core contract tests (no LLM)

```bash
bun test packages/core/src/governance-backend.test.ts
```

Covers: `PolicyRequest` shape, `GovernanceVerdict` discriminated union, `Violation` shape, `ViolationSeverity` values, `VIOLATION_SEVERITY_ORDER` ordering and immutability, `GOVERNANCE_ALLOW` singleton, `ComplianceRecord` shape, `ViolationFilter` and `ViolationPage` pagination, `GovernanceBackend` composite interface structural conformance, ISP sub-interface independence.

### Mock factory (test-utils)

```bash
bun test packages/test-utils/src/governance-backend.test.ts
```

`createMockGovernanceBackend()` provides a configurable mock with all sub-interfaces for testing middleware and consumers.

### E2E tests (real Anthropic API)

```bash
# Loop adapter E2E (wrapModelCall path)
bun scripts/e2e-governance-backend.ts

# Pi adapter E2E (wrapModelStream path)
bun scripts/e2e-governance-backend-pi.ts
```

| Script | Adapter | Tests | Assertions | What it proves |
|--------|---------|-------|------------|----------------|
| `e2e-governance-backend.ts` | Loop | 7 | 36 | Full contract through `createKoi + createLoopAdapter` |
| `e2e-governance-backend-pi.ts` | Pi | 7 | 36 | Full contract through `createKoi + createPiAdapter` |

Both scripts test:

1. ComponentProvider wiring under `GOVERNANCE_BACKEND` token
2. PolicyEvaluator called through middleware on real LLM call
3. Deny verdict blocks model call (fail-closed enforcement)
4. ComplianceRecorder captures audit trail
5. ConstraintChecker called per-request
6. GovernanceBackend + GovernanceController coexist as parallel peers
7. Scope-filtered evaluator skips non-matching kinds

---

## Source Files

| File | Purpose |
|------|---------|
| `packages/core/src/governance-backend.ts` | L0 types: GovernanceBackend, PolicyEvaluator, GovernanceVerdict, Violation, ComplianceRecord |
| `packages/core/src/ecs.ts` | `GOVERNANCE_BACKEND` ECS token |
| `packages/core/src/index.ts` | Re-exports all types and constants |
| `packages/test-utils/src/governance.ts` | `createMockGovernanceBackend()` factory |
| `scripts/e2e-governance-backend.ts` | Loop adapter E2E test script |
| `scripts/e2e-governance-backend-pi.ts` | Pi adapter E2E test script |

---

## API Reference

### Types

| Export | Kind | Description |
|--------|------|-------------|
| `GovernanceBackend` | interface | The main composite contract |
| `PolicyEvaluator` | interface | Core policy evaluation sub-interface |
| `ConstraintChecker` | interface | Individual constraint checking |
| `ComplianceRecorder` | interface | Audit trail recording |
| `ViolationStore` | interface | Violation history queries |
| `PolicyRequest` | interface | Input to `evaluate()` |
| `PolicyRequestKind` | type | `"tool_call" \| "model_call" \| "spawn" \| ...` |
| `GovernanceVerdict` | type | Discriminated union: allow (with diagnostics) or deny (with violations) |
| `Violation` | interface | Rule + severity + message |
| `ViolationSeverity` | type | `"info" \| "warning" \| "critical"` |
| `ConstraintQuery` | interface | Input to `checkConstraint()` |
| `ComplianceRecord` | interface | Request + verdict + policy fingerprint |
| `ViolationFilter` | interface | Filter for `getViolations()` |
| `ViolationPage` | interface | Paginated violation results |

### Runtime Values

| Export | Type | Value |
|--------|------|-------|
| `GOVERNANCE_BACKEND` | `SubsystemToken<GovernanceBackend>` | ECS component key |
| `GOVERNANCE_ALLOW` | `GovernanceVerdict` | Frozen singleton `{ ok: true }` |
| `VIOLATION_SEVERITY_ORDER` | `readonly ViolationSeverity[]` | `["info", "warning", "critical"]` |
| `DEFAULT_VIOLATION_QUERY_LIMIT` | `number` | `100` |
