# GovernanceBackend

Pluggable policy evaluation socket — every model call and tool call is gated,
every verdict is attested, every violation is queryable.

**Layer**: L0 types (`@koi/core`) · consumed by L1 middleware + L2 implementations
**Issue**: #265

---

## Overview

`GovernanceBackend` is an L0 contract that lets you inject a policy engine into
the Koi middleware chain. Every model stream, every tool call, every spawn event
passes through `evaluate()` before reaching the LLM or tool. If the backend
denies the call, the middleware throws before the operation occurs. If it allows,
a compliance attestation is written to the audit log.

The backend is pluggable — swap in-memory rules for Nexus ReBAC over HTTP, or
OPA, or your own compliance service, without touching the middleware or the engine.

```
  createKoi()  →  middleware chain (onion)
                         │
               [0] IterationGuard         (spawn / loop limits)
                         │
               [1] GovernanceMiddleware   ◄── you wire this in
                         │
                    wrapModelStream / wrapToolCall
                    ┌────────────────────────────────┐
                    │ 1. backend.evaluate(event)      │
                    │         │                       │
                    │    ok:true ──► stream chunks    │
                    │         │     + recordAttestation│
                    │    ok:false ──► recordAttestation│
                    │              + THROW (blocked)  │
                    └────────────────────────────────┘
                         │
               [∞] createPiAdapter  (LLM — only if allowed)
```

---

## What This Enables

### Per-call policy gate with full audit trail

```
  Model call request
        │
        ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │  GovernanceBackend.evaluate({ kind: "model_stream", agentId,    │
  │                               payload: { model, tokens }, ... }) │
  │                                                                  │
  │  ok: true  ──► allow (LLM called)                               │
  │              └─► recordAttestation({ agentId, ruleId: "...",    │
  │                    verdict: { ok: true }, evidence: { tokens }}) │
  │                                                                  │
  │  ok: false ──► deny (LLM never called, middleware throws)        │
  │              └─► recordAttestation({ agentId, ruleId: "...",    │
  │                    verdict: { ok: false, violations: [...] }})   │
  └─────────────────────────────────────────────────────────────────┘
```

### Queryable violation log

```
  dashboard / monitor:
    backend.getViolations({
      agentId: "agent-xyz",
      severity: ["critical"],
      after: Date.now() - 3_600_000,   // last hour
    })
    → [
        { rule: "cost-limit", severity: "critical",
          message: "Cost $0.98 approaching limit $1.00" },
        { rule: "max-spawn-depth", severity: "critical",
          message: "Spawn depth 6 exceeds limit 5" },
      ]
```

### Swap implementations without touching the engine

```
  In-memory (tests)        Nexus ReBAC (prod)        OPA / custom
  ┌───────────────┐        ┌───────────────────┐     ┌────────────────┐
  │ Map<id,attest>│        │ HTTP → nexus.io   │     │ OPA evaluate   │
  │ allow all     │        │ JWT + ReBAC policy│     │ AWS Macie      │
  │ fast, no deps │        │ async enforcement │     │ your rules     │
  └───────────────┘        └───────────────────┘     └────────────────┘
          ▲                         ▲                       ▲
          └─────────────────────────┴───────────────────────┘
                      same GovernanceBackend interface
```

---

## Relationship to GovernanceController

`GovernanceBackend` and `GovernanceController` solve different problems and are
complementary:

| | GovernanceController | GovernanceBackend |
|---|---|---|
| **What** | Sensor/setpoint resource monitor | Pluggable policy evaluation engine |
| **Layer** | L0 types + L1 runtime | L0 types + L2 implementations |
| **Tracks** | Turn count, tokens, cost, error rate, spawn depth | Policy rules, violations, attestations |
| **Failure mode** | `KoiRuntimeError` on limit exceeded | Throw = deny (fail-closed) |
| **Extensibility** | L2 contributor pattern (add sensors) | Swap entire backend (OPA, Nexus, custom) |
| **Output** | `GovernanceCheck` (one sensor) / `GovernanceSnapshot` (all) | `GovernanceVerdict` (zero or more violations across all rules) |
| **Audit** | `snapshot()` in-memory snapshot | `recordAttestation()` + `getViolations()` persistent log |
| **Source** | `packages/core/src/governance.ts` | `packages/core/src/governance-backend.ts` |

Use `GovernanceController` to enforce budget limits (turn cap, token cap, cost cap).
Use `GovernanceBackend` to enforce policy rules (data exfiltration, tool allowlist, compliance).

---

## Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Fail-closed contract | `evaluate()` throw = deny | Infrastructure failure must not equal permissive. Same guarantee as a firewall: fail-closed beats fail-open |
| Result only on I/O methods | `evaluate()` / `checkConstraint()` throw; `recordAttestation()` / `getViolations()` return `Result` | Callers of evaluate must act on denial — Result adds indirection. Storage errors are structured (retryable vs permanent) |
| Open event kind | `GovernanceBackendEvent.kind: string` | Closed union would block L2 packages from adding custom event kinds. Well-known kinds documented, extensions allowed |
| `T \| Promise<T>` on all methods | Sync and async | In-memory backends (tests) are sync. Nexus/OPA/SQLite backends are async. Same interface for both |
| Multiple violations per verdict | `violations: readonly Violation[]` | "First violation wins" hides downstream policy violations. All rules are checked, all violations reported |
| Severity as ordered array | `VIOLATION_SEVERITIES = ["info","warning","critical"]` | `indexOf` enables `>=` comparison without enums. Frozen for runtime immutability |
| Branded attestation ID | `GovernanceAttestationId = Brand<string, "GovernanceAttestationId">` | Prevents mixing with ProposalId, BrickId, etc. at compile time. Zero runtime cost (identity cast) |
| Idempotent attestations | Implementations SHOULD deduplicate | Callers record on every allow/deny. Retry storms must not create duplicate audit entries |

---

## Architecture

### Layer separation

```
L0  @koi/core
┌────────────────────────────────────────────────────────────────┐
│  governance-backend.ts                                         │
│                                                                │
│  GovernanceBackend        — main pluggable interface           │
│  GovernanceBackendEvent   — open-kind event for evaluate()     │
│  GovernanceVerdict        — ok:true | ok:false + violations    │
│  Violation                — rule + severity + message + context│
│  ViolationSeverity        — "info" | "warning" | "critical"    │
│  VIOLATION_SEVERITIES     — ordered frozen array               │
│  ConstraintQuery          — input for checkConstraint()        │
│  ViolationQuery           — filter for getViolations()         │
│  DEFAULT_VIOLATION_QUERY_LIMIT — 100 (pagination default)      │
│  GovernanceAttestation    — stored compliance claim            │
│  GovernanceAttestationInput — caller-supplied attestation data │
│  GovernanceAttestationId  — branded string identity            │
│  governanceAttestationId()— branded constructor (identity cast)│
│                                                                │
│  Imports only: ./common.js  ./ecs.js  ./errors.js             │
│  Zero @koi/* workspace deps                                    │
└────────────────────────────────────────────────────────────────┘

L2  @koi/governance (future)            L2  @koi/governance-nexus (future)
┌───────────────────────────────┐       ┌────────────────────────────────┐
│  Local in-process policy eval │       │  Nexus brick — attestation,    │
│  SQLite audit log             │       │  ReBAC, compliance API         │
│  Implements GovernanceBackend │       │  Implements GovernanceBackend  │
└───────────────────────────────┘       └────────────────────────────────┘

L1  @koi/engine (consumer, wires middleware)
┌──────────────────────────────────────────────────────────────────┐
│  GovernanceMiddleware (createGovernanceMiddleware)               │
│  — wraps wrapModelStream / wrapToolCall with evaluate() calls    │
│  — records attestations after each call (allow or deny)          │
│  — throws before LLM/tool when verdict is ok:false               │
└──────────────────────────────────────────────────────────────────┘
```

### Full call flow (model stream)

```
  Middleware onion resolves wrapModelStream:

  wrapModelStream(ctx, request, next):
    ┌───────────────────────────────────────────────────────────┐
    │                                                           │
    │  1. Build GovernanceBackendEvent:                         │
    │       { kind: "model_stream", agentId, payload: {        │
    │           model: request.model,                          │
    │           inputMessages: request.messages.length         │
    │         }, timestamp: Date.now() }                        │
    │                                                           │
    │  2. verdict = await backend.evaluate(event)               │
    │                                                           │
    │  3. verdict.ok === false?                                 │
    │       → await backend.recordAttestation({                 │
    │           agentId, ruleId: "model-call-allowed",          │
    │           verdict, evidence: { kind: "model_stream" }     │
    │         })                                                │
    │       → throw (blocked — LLM never called)                │
    │                                                           │
    │  4. for await (chunk of next(request)):                   │
    │       if chunk.kind === "done":                           │
    │         await backend.recordAttestation({                 │
    │           agentId, ruleId: "model-call-allowed",          │
    │           verdict: { ok: true },                          │
    │           evidence: {                                     │
    │             kind: "model_stream",                         │
    │             model: request.model,                         │
    │             inputTokens: chunk.response.usage?.input,     │
    │             outputTokens: chunk.response.usage?.output    │
    │           }                                               │
    │         })  ← BEFORE yielding done chunk                  │
    │       yield chunk                                         │
    │                                                           │
    └───────────────────────────────────────────────────────────┘

  NOTE: Attestation recorded BEFORE yielding the "done" chunk.
  Reason: the stream-bridge's `for await` exits via `return` on
  the done chunk, calling .return() on the outer iterator and
  closing the generator — any post-yield code is unreachable.
```

### Fail-closed enforcement

```
  Infrastructure failure scenario:

  backend.evaluate(event)
        │
        ▼  throws: "Connection to policy server refused"
        │
  ┌─────────────────────────────────────┐
  │  Middleware catch block              │
  │                                     │
  │  Rule: throw = deny                 │
  │  Does NOT call recordAttestation    │
  │  (infra failure, not a verdict)     │
  │                                     │
  │  Re-throws — engine converts to     │
  │  stopReason: "error"                │
  └─────────────────────────────────────┘

  Key: the LLM is never called.
  Policy server offline ≡ policy enforcement active.
```

---

## L0 Types

### GovernanceBackend interface

```typescript
interface GovernanceBackend {
  // Gate: evaluate before every operation. Throw = deny.
  readonly evaluate: (event: GovernanceBackendEvent) =>
    GovernanceVerdict | Promise<GovernanceVerdict>;

  // Spot-check: "is constraint X still satisfied?"
  readonly checkConstraint: (constraint: ConstraintQuery) =>
    boolean | Promise<boolean>;

  // Audit: record the outcome of every evaluate() call.
  readonly recordAttestation: (input: GovernanceAttestationInput) =>
    Result<GovernanceAttestation, KoiError>
    | Promise<Result<GovernanceAttestation, KoiError>>;

  // Query: surface violations for dashboards, monitors, alerts.
  readonly getViolations: (filter: ViolationQuery) =>
    Result<readonly Violation[], KoiError>
    | Promise<Result<readonly Violation[], KoiError>>;

  // Optional cleanup (close DB, flush buffer, end connection pool).
  readonly dispose?: () => void | Promise<void>;
}
```

### GovernanceBackendEvent

```typescript
interface GovernanceBackendEvent {
  // Well-known kinds: "tool_call" | "spawn" | "forge" | "promotion" | "proposal"
  // Open string — L2 packages may add custom kinds.
  readonly kind: string;
  readonly agentId: AgentId;
  readonly payload: JsonObject;    // backend-specific structured data
  readonly timestamp: number;      // Unix ms
}
```

### GovernanceVerdict

```typescript
type GovernanceVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly Violation[] };
```

All violated rules are included — not just the first. Consumers decide whether
to deny on any violation or only on specific severities.

### Violation

```typescript
interface Violation {
  readonly rule: string;              // backend-defined rule ID
  readonly severity: ViolationSeverity; // "info" | "warning" | "critical"
  readonly message: string;           // what happened + why
  readonly context?: JsonObject;      // optional structured data (thresholds, etc.)
}
```

### ViolationSeverity ordering

```typescript
const VIOLATION_SEVERITIES: readonly ViolationSeverity[] =
  Object.freeze(["info", "warning", "critical"]);

// Severity comparison via indexOf:
const atLeastWarning = (s: ViolationSeverity): boolean =>
  VIOLATION_SEVERITIES.indexOf(s) >= VIOLATION_SEVERITIES.indexOf("warning");

atLeastWarning("info")     // false
atLeastWarning("warning")  // true
atLeastWarning("critical") // true
```

### GovernanceAttestation

The stored compliance claim. Immutable — never mutated after `recordAttestation()`.

```typescript
interface GovernanceAttestation {
  readonly id: GovernanceAttestationId;  // backend-assigned
  readonly agentId: AgentId;
  readonly ruleId: string;
  readonly verdict: GovernanceVerdict;
  readonly evidence?: JsonObject;
  readonly attestedAt: number;           // backend-assigned Unix ms
  readonly attestedBy: string;           // "local" | "nexus" | custom
}
```

`attestedBy` lets you distinguish attestations from different backends in a
mixed-backend deployment.

### ViolationQuery

```typescript
interface ViolationQuery {
  readonly agentId?: AgentId;
  readonly severity?: readonly ViolationSeverity[];
  readonly ruleId?: string;
  readonly after?: number;       // Unix ms lower bound (inclusive)
  readonly before?: number;      // Unix ms upper bound (exclusive)
  readonly limit?: number;       // defaults to DEFAULT_VIOLATION_QUERY_LIMIT (100)
}
```

All fields are optional. Omitting all fields returns all violations up to the
limit — use with care in high-volume deployments.

---

## Usage

### Wire into createKoi

```typescript
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import type { GovernanceBackend, GovernanceBackendEvent, GovernanceVerdict } from "@koi/core/governance-backend";

// 1. Implement GovernanceBackend (or use a pre-built L2 implementation)
const backend: GovernanceBackend = {
  evaluate(event: GovernanceBackendEvent): GovernanceVerdict {
    if (event.kind === "spawn" && (event.payload["depth"] as number) > 3) {
      return {
        ok: false,
        violations: [{
          rule: "max-spawn-depth",
          severity: "critical",
          message: `Spawn depth ${event.payload["depth"]} exceeds limit 3`,
          context: { limit: 3, actual: event.payload["depth"] },
        }],
      };
    }
    return { ok: true };
  },

  checkConstraint({ constraintId, agentId }) {
    // Point-in-time constraint checks (e.g., "is this agent still within budget?")
    return true;
  },

  recordAttestation(input) {
    const stored = {
      id: governanceAttestationId(`attest-${Date.now()}`),
      ...input,
      attestedAt: Date.now(),
      attestedBy: "local",
    };
    return { ok: true, value: stored };
  },

  getViolations(filter) {
    return { ok: true, value: [] };
  },
};

// 2. Create governance middleware
const governanceMiddleware = createGovernanceMiddleware(backend);

// 3. Wire into createKoi
const runtime = await createKoi({
  manifest: { name: "my-agent", version: "1.0.0", model: { name: "claude-sonnet" } },
  adapter: createPiAdapter({ model: "...", getApiKey: async () => process.env.ANTHROPIC_API_KEY! }),
  middleware: [governanceMiddleware],
});
```

### Query violations after a session

```typescript
const result = await backend.getViolations({
  agentId: myAgent.pid.id,
  severity: ["warning", "critical"],
  after: sessionStart,
});

if (result.ok) {
  for (const v of result.value) {
    console.log(`[${v.severity}] ${v.rule}: ${v.message}`);
  }
}
```

### Async backend (Nexus ReBAC over HTTP)

```typescript
const nexusBackend: GovernanceBackend = {
  async evaluate(event) {
    const res = await fetch("https://nexus.internal/governance/evaluate", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(event),
    });
    if (!res.ok) throw new Error(`Nexus evaluate failed: ${res.status}`);
    return res.json() as Promise<GovernanceVerdict>;
  },
  // ... recordAttestation, getViolations, dispose
};
```

Because `evaluate()` is `T | Promise<T>`, the middleware always `await`s — the
in-memory sync backend and the async Nexus backend use the same interface.

### Severity filtering in middleware

Middleware that only blocks on `critical`, logs on `warning`:

```typescript
const verdict = await backend.evaluate(event);
if (!verdict.ok) {
  const criticals = verdict.violations.filter(v =>
    VIOLATION_SEVERITIES.indexOf(v.severity) >= VIOLATION_SEVERITIES.indexOf("critical")
  );
  if (criticals.length > 0) {
    await backend.recordAttestation({ agentId, ruleId: "policy-gate", verdict });
    throw new Error(`Governance denied: ${criticals.map(v => v.rule).join(", ")}`);
  }
  // warning-only: log and continue
}
```

---

## Performance

### Hot-path cost

```
Per model call / tool call:

  evaluate()            — sync in-memory: ~0.1 µs
                        — async SQLite:   ~0.5-2 ms
                        — async HTTP:     ~10-50 ms (Nexus, network dependent)

  recordAttestation()   — sync in-memory: ~0.1 µs
                        — async SQLite:   ~1-5 ms (write)
                        — async HTTP:     ~10-50 ms

  Total overhead:
    In-memory backend:  < 1 µs per call — negligible vs 500ms+ LLM latency
    SQLite backend:     1-10 ms per call — acceptable for most use cases
    HTTP backend:       10-100 ms per call — adds observable latency; use
                        connection pooling + local cache for hot paths
```

### Avoid double-await

`T | Promise<T>` returns are guaranteed safe to `await` — `await` on a non-Promise
is a no-op. Do not add `instanceof Promise` checks before awaiting.

```typescript
// Correct — always await, even for sync backends:
const verdict = await backend.evaluate(event);

// Wrong — unnecessary check:
const raw = backend.evaluate(event);
const verdict = raw instanceof Promise ? await raw : raw;
```

---

## Source Files

| File | Purpose |
|---|---|
| `packages/core/src/governance-backend.ts` | L0 types: all interfaces, `GovernanceBackend`, constants, branded constructor |
| `packages/core/src/governance-backend.test.ts` | Unit tests: branded constructor, constants, structural shape, interface contract |
| `packages/engine/__tests__/governance-backend-e2e.test.ts` | E2E tests: full createKoi + createPiAdapter + real Anthropic API (10 tests) |

### Tests

| File | Cases |
|---|---|
| `packages/core/src/governance-backend.test.ts` | 19 unit tests — branded ID, VIOLATION_SEVERITIES, GovernanceVerdict, GovernanceBackendEvent, GovernanceAttestation, ViolationQuery, interface contract |
| `packages/engine/__tests__/governance-backend-e2e.test.ts` | 10 E2E tests — allow path (attestation written), deny path (LLM blocked, attestation written), tool call gate, constraint check, violation query, fail-closed on evaluate throw, dispose called on shutdown, multi-violation verdict, coexistence with GovernanceController |

---

## Relationship to Other Subsystems

```
                      ┌──────────────────────┐
                      │    GovernanceBackend  │  (L0 interface)
                      │    @koi/core          │
                      └──────────┬───────────┘
                                 │
           ┌─────────────────────┼──────────────────────┐
           │                     │                      │
           ▼                     ▼                      ▼
  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────────┐
  │ GovernanceMiddle│  │ ProposalGate     │  │ AgentMonitor (#59)   │
  │ ware (L1 engine)│  │ (L0 proposal.ts) │  │ (L2 agent-monitor)   │
  │                 │  │                  │  │                      │
  │ wrapModelStream │  │ checks backend   │  │ queries violations   │
  │ wrapToolCall    │  │ before structural│  │ for health dashboard │
  │ wires evaluate()│  │ layer changes    │  │ + alerting           │
  │ + attest()      │  │ (promotion, forge│  │                      │
  └─────────────────┘  │  proposal)       │  └──────────────────────┘
                       └──────────────────┘

  Distinct from:
  ┌────────────────────────────────────────────────────────────┐
  │ GovernanceController (governance.ts)                        │
  │                                                             │
  │ sensor/setpoint resource monitor — turn cap, token cap,    │
  │ cost cap, error rate. Immutable counters, no pluggable      │
  │ backend. Complementary to GovernanceBackend, not competing  │
  └────────────────────────────────────────────────────────────┘

  ┌────────────────────────────────────────────────────────────┐
  │ AuditSink (audit-backend.ts)                                │
  │                                                             │
  │ Structured audit log for all engine events (tool calls,     │
  │ model calls, errors). Append-only write path.               │
  │ GovernanceBackend records compliance attestations (verdicts)│
  │ — a different concern from raw audit logging                │
  └────────────────────────────────────────────────────────────┘
```

## Comparison with Prior Art

| Concept | Koi GovernanceBackend | OpenClaw sentinel-mcp | NanoClaw |
|---|---|---|---|
| Policy socket | L0 interface — swap without touching engine | Third-party MCP sidecar | None (container-only) |
| Fail-closed | throw = deny (enforced by contract) | Timeout = pass-through risk | N/A |
| Attestation | `recordAttestation()` (structured, queryable) | Hash-chained JSONL log | No |
| Violation query | `getViolations()` with filters | No query API | No |
| Async support | `T \| Promise<T>` on all methods | Sync only | N/A |
| Multiple violations | Full violation list per verdict | First match only | N/A |
| Layer position | L0 kernel contract | External sidecar | N/A |
| Extensibility | Swap entire backend (OPA, Nexus, custom) | Fork sidecar | N/A |
