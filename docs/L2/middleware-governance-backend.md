# @koi/middleware-governance-backend — Pluggable Policy Evaluation Gate

`@koi/middleware-governance-backend` is an L2 middleware package that gates every model call and tool call through a pluggable `GovernanceBackend` evaluator. If the evaluator denies a request, the middleware throws and the action never executes.

**Fail-closed by design:** if `evaluate()` throws, the error propagates as a denial. A broken backend means "deny all", never "allow all".

---

## Why it exists

Agents operate in environments with rules: compliance policies, security boundaries, usage quotas, content restrictions. Without a governance layer, every agent must implement its own policy checks — or worse, operate unchecked.

```
Without governance middleware:

  LLM: "I'll call deploy_prod"
  Tool: deploy_prod ──▶ executes ──▶ 💥 violated compliance policy
                                       (nobody checked)

With governance middleware:

  LLM: "I'll call deploy_prod"
  Middleware: evaluate({ kind: "tool_call", toolId: "deploy_prod" })
       │
       ├── verdict.ok === true  ──▶ tool executes normally
       └── verdict.ok === false ──▶ throw Error("Governance policy violation: ...")
                                     tool never executes
```

This middleware solves three problems:

1. **Universal gate** — every model call and tool call passes through the evaluator, no exceptions
2. **Pluggable backends** — swap between OPA, Cedar, in-memory rules, or custom evaluators by implementing one interface
3. **Compliance recording** — optional audit trail via `ComplianceRecorder`

---

## Architecture

### Layer position

```
L0  @koi/core                    ─ GovernanceBackend, PolicyEvaluator,
                                    PolicyRequest, GovernanceVerdict,
                                    KoiMiddleware (types only)
L2  @koi/middleware-governance-backend  ─ this package (no L1 dependency)
```

`@koi/middleware-governance-backend` imports only from `@koi/core`. It never touches `@koi/engine` (L1), making it fully swappable and independently testable.

### Internal module map

```
index.ts                          ← public re-exports
│
├── config.ts                     ← GovernanceBackendMiddlewareConfig + validateGovernanceBackendConfig()
└── governance-backend-middleware.ts ← createGovernanceBackendMiddleware() factory
                                      gate() function + wrapModelCall/wrapModelStream/wrapToolCall
```

### Hook mapping

| Hook | What runs |
|---|---|
| `wrapModelCall` | `gate({ kind: "model_call" })` before `next(request)` |
| `wrapModelStream` | `gate({ kind: "model_call" })` before `yield* next(request)` |
| `wrapToolCall` | `gate({ kind: "tool_call" })` before `next(request)` |
| `onSessionEnd` | `backend.dispose?.()` for cleanup |
| `describeCapabilities` | Returns `{ label: "governance", description: "Policy evaluation gate active..." }` |

### Data flow (single tool call)

```
wrapToolCall(ctx, request, next)
       │
       ├─ construct PolicyRequest {
       │    kind: "tool_call",
       │    agentId: ctx.session.agentId,
       │    payload: { toolId, input },
       │    timestamp: Date.now(),
       │  }
       │
       ├─ backend.evaluator.evaluate(policyRequest)
       │    │
       │    ├── verdict.ok === true ──▶ return next(request)  (tool executes)
       │    │
       │    └── verdict.ok === false
       │         ├── onViolation?.(verdict, policyRequest)
       │         ├── backend.compliance?.recordCompliance(...)  (fire-and-forget)
       │         └── throw Error("Governance policy violation: <messages>")
       │
       └── evaluate() throws ──▶ error propagates (fail-closed)
```

### Capability injection

The middleware implements `describeCapabilities()` returning a static fragment:

```
[Active Capabilities]
- **governance**: Policy evaluation gate active. Model and tool calls are subject to governance rules.
```

This tells the LLM that a governance layer is active, so it can anticipate that certain actions may be denied rather than discovering it through failed calls.

---

## The GovernanceBackend contract (L0)

The backend is defined in `@koi/core/governance-backend` and follows the PEP-PDP pattern (Policy Enforcement Point / Policy Decision Point):

```
┌──────────────────┐    PolicyRequest    ┌──────────────────┐
│  Middleware (PEP) │───────────────────▶│  Backend (PDP)   │
│  constructs the   │                    │  evaluates the   │
│  request          │◀──────────────────│  policy          │
└──────────────────┘  GovernanceVerdict  └──────────────────┘
```

### Sub-interfaces (ISP split)

| Interface | Required | Purpose |
|---|---|---|
| `PolicyEvaluator` | Yes | Core: evaluate a `PolicyRequest` → `GovernanceVerdict` |
| `ConstraintChecker` | No | Individual limit checks (numeric/boolean) |
| `ComplianceRecorder` | No | Record compliance events for audit trails |
| `ViolationStore` | No | Query violation history |
| `dispose()` | No | Cleanup for stateful backends |

### PolicyRequest kinds

```
"tool_call"      ← tool execution
"model_call"     ← LLM inference call
"spawn"          ← child agent creation
"delegation"     ← task delegation
"forge"          ← brick forging
"handoff"        ← agent handoff
"custom:${string}" ← domain-specific extensions
```

### GovernanceVerdict

```typescript
type GovernanceVerdict =
  | { ok: true; diagnostics?: Violation[] }   // allowed (with optional observations)
  | { ok: false; violations: Violation[] }     // denied (with reasons)
```

---

## API

### `createGovernanceBackendMiddleware(config)`

```typescript
import { createGovernanceBackendMiddleware } from "@koi/middleware-governance-backend";

const middleware = createGovernanceBackendMiddleware({
  backend: myGovernanceBackend,
  onViolation: (verdict, request) => {
    console.warn(`Policy violation on ${request.kind}:`, verdict.violations);
  },
});
```

Returns a `KoiMiddleware` with `name: "koi:governance-backend"` and `priority: 150`.

### `GovernanceBackendMiddlewareConfig`

```typescript
interface GovernanceBackendMiddlewareConfig {
  /** The governance backend instance. */
  readonly backend: GovernanceBackend;
  /** Optional callback invoked on every denial (before the error is thrown). */
  readonly onViolation?: (verdict: GovernanceVerdict, request: PolicyRequest) => void;
}
```

### `validateGovernanceBackendConfig(config)`

Validates untrusted config at initialization time:

```typescript
import { validateGovernanceBackendConfig } from "@koi/middleware-governance-backend";

const result = validateGovernanceBackendConfig(untrustedOptions);
if (!result.ok) {
  throw new Error(`invalid governance config: ${result.error.message}`);
}
const middleware = createGovernanceBackendMiddleware(result.value);
```

Validation rules:
- `backend` must be a non-null object with an `evaluator` object
- `onViolation` must be a function (if present)

---

## Examples

### 1. In-memory allow-all backend

```typescript
import type { GovernanceBackend } from "@koi/core/governance-backend";
import { createGovernanceBackendMiddleware } from "@koi/middleware-governance-backend";

const allowAll: GovernanceBackend = {
  evaluator: { evaluate: async () => ({ ok: true }) },
};

const middleware = createGovernanceBackendMiddleware({ backend: allowAll });
```

### 2. Deny specific tools

```typescript
const denyDestructive: GovernanceBackend = {
  evaluator: {
    evaluate: async (request) => {
      if (request.kind === "tool_call") {
        const toolId = (request.payload as { toolId: string }).toolId;
        if (["rm_rf", "drop_table", "deploy_prod"].includes(toolId)) {
          return {
            ok: false,
            violations: [{
              rule: "no-destructive-tools",
              severity: "critical",
              message: `Tool "${toolId}" is not allowed by policy`,
            }],
          };
        }
      }
      return { ok: true };
    },
  },
};
```

### 3. With compliance recording

```typescript
const auditedBackend: GovernanceBackend = {
  evaluator: { evaluate: myPolicyEngine.evaluate },
  compliance: {
    recordCompliance: async (record) => {
      await db.insert("compliance_log", record);
      return record;
    },
  },
};

const middleware = createGovernanceBackendMiddleware({
  backend: auditedBackend,
  onViolation: (verdict, request) => {
    alerting.send(`Policy violation by ${request.agentId}: ${verdict.violations[0]?.message}`);
  },
});
```

### 4. With createKoi

```typescript
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createGovernanceBackendMiddleware } from "@koi/middleware-governance-backend";

const runtime = await createKoi({
  manifest: { name: "governed-agent", version: "1.0.0", model: { name: "claude-haiku" } },
  adapter: createPiAdapter({ ... }),
  middleware: [
    createGovernanceBackendMiddleware({ backend: myBackend }),
  ],
});
```

---

## Priority and middleware ordering

`@koi/middleware-governance-backend` has `priority: 150`, placing it early in the chain:

```
priority: 100  internal guards (iteration, loop detection)
priority: 150  @koi/middleware-governance-backend  ← THIS (gate before anything runs)
priority: 200  @koi/middleware-audit               (audit after governance gate)
priority: 300  @koi/middleware-permissions          (fine-grained tool permissions)
priority: 500  default middleware
```

**Why 150?** Governance is a hard gate — if policy denies a request, nothing else should run. Placing it before audit (200) ensures denied requests are caught before they generate audit entries for allowed actions. Placing it after internal guards (100) ensures the engine's own safety mechanisms run first.

---

## Fail-closed semantics

The middleware is explicitly fail-closed at every level:

```
evaluate() returns ok:true  ──▶ proceed
evaluate() returns ok:false ──▶ throw (deny)
evaluate() throws           ──▶ error propagates (deny)
backend is null/undefined   ──▶ validateGovernanceBackendConfig rejects (deny at config time)
```

This is a design constraint, not an implementation detail. The L0 contract (`GovernanceBackend`) documents it: "callers MUST deny access when evaluate() throws or returns an error."

---

## Performance properties

| Operation | Cost | Notes |
|---|---|---|
| `gate()` per model call | 1 `evaluate()` call | Async — backend determines latency |
| `gate()` per tool call | 1 `evaluate()` call | Same as model call |
| Compliance recording | Fire-and-forget `Promise` | Never blocks the denial throw |
| `describeCapabilities()` | Cached object return | Zero allocation per call |
| `onSessionEnd` cleanup | 1 `dispose()` call | Only if backend provides it |

The middleware adds one async hop per model/tool call. For in-memory backends this is sub-microsecond. For remote backends (OPA, Cedar over HTTP), latency depends on the network.

---

## Layer compliance

```
L0  @koi/core ────────────────────────────────────────────────┐
    GovernanceBackend, PolicyEvaluator, PolicyRequest,         │
    GovernanceVerdict, Violation, ViolationSeverity,           │
    ComplianceRecord, ComplianceRecorder, ConstraintChecker,   │
    KoiMiddleware, TurnContext, SessionContext                 │
                                                               │
                                                               ▼
L2  @koi/middleware-governance-backend ◄──────────────────────┘
    imports from L0 only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external dependencies
```
