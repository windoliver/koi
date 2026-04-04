# Inference Scope — Permissioned Reasoning over Decision Traces

**Status:** Design draft (Phase 2 of #1471)
**Author:** @SophiaWJ
**Date:** 2026-04-02

---

## Problem

Nexus ReBAC controls **access** — can agent X read resource Y. But there is no mechanism
for **permissioned inference** — can reasoning about client A's decision history influence
recommendations for client B?

Example: A law firm uses Koi agents for contract negotiation. Client A's precedent decisions
(IP clause structuring) must not leak into reasoning for Client B, even if both are served
by the same agent pool. If decision traces from both clients share a Nexus namespace, there
is no guardrail today.

This is distinct from data access control — it is about controlling what the **model is
allowed to reason over**, not what the **user is allowed to see**.

### Current state

- `@koi/permissions` gates tool execution (action-level control)
- `@koi/redaction` masks secrets in logs (data-level masking)
- Nexus agent namespace isolation (`agents/{id}/...`) provides entity-level separation
- Cross-agent decision retrieval (for "similar past decisions" in #1465) would break
  this boundary

**Gap:** No mechanism to scope what past decisions the model may reason about during
inference.

---

## Proposed Design

### 1. Scope Tags on Decision Traces

Each decision trace (ATIF trajectory step, outcome record) carries a scope tag set at
recording time from the agent's manifest and session context.

```typescript
interface InferenceScope {
  /** Tenant/organization boundary. Required. */
  readonly tenant: string;
  /** Project or engagement within a tenant. Optional refinement. */
  readonly project?: string | undefined;
  /** Confidentiality classification. Optional. */
  readonly confidentiality?: "public" | "internal" | "confidential" | "restricted" | undefined;
}
```

Scope tags are **immutable after recording** — they represent the context in which a
decision was made, not the current access policy.

### 2. Scope Tags in L0

Add to `@koi/core` `SessionContext`:

```typescript
interface SessionContext {
  // ... existing fields
  /** Inference scope for this session. Injected by L1 from manifest + runtime config. */
  readonly inferenceScope?: InferenceScope | undefined;
}
```

And to ATIF extension fields (via `extra`):

```typescript
// ATIF step extra field
{
  "inference_scope": { "tenant": "acme-law", "project": "client-a", "confidentiality": "confidential" }
}
```

### 3. ScopeFilter for Retrieval

When `@koi/memory` or the decision index retrieves past decisions for context injection,
a `ScopeFilter` limits results to the current session's allowed scopes.

```typescript
interface ScopeFilter {
  /** Only include traces matching these tenants. */
  readonly tenants: readonly string[];
  /** Only include traces matching these projects (within allowed tenants). */
  readonly projects?: readonly string[] | undefined;
  /** Maximum confidentiality level to include. */
  readonly maxConfidentiality?: "public" | "internal" | "confidential" | "restricted" | undefined;
}
```

**Resolution order:**
1. Session's `inferenceScope` provides the default filter
2. Explicit filter in retrieval query can restrict further (never widen)
3. If no scope is set, retrieval defaults to the current session's own traces only

### 4. Middleware Enforcement

A new `@koi/middleware-inference-scope` (L2, Phase 3) wraps `wrapModelCall`:

- **Before model call:** Inspect any injected context (past decisions, memory results)
  in the model request. Verify all injected artifacts carry scope tags within the
  current session's allowed scopes.
- **On violation:** Strip the out-of-scope artifacts and log an audit event.
- **Fail-closed:** If scope tags are missing from an artifact, treat as out-of-scope.

### 5. Audit Trail for Scope Crossings

Any query that touches cross-scope data (even if denied) is logged:

```typescript
interface ScopeCrossingAuditEntry {
  readonly kind: "scope_crossing";
  readonly sessionId: string;
  readonly requestedScope: InferenceScope;
  readonly currentScope: InferenceScope;
  readonly artifactId: string;
  readonly decision: "denied" | "allowed_by_override";
  readonly timestamp: number;
}
```

---

## Interaction with Existing Systems

| System | Relationship |
|--------|-------------|
| `@koi/permissions` | Complementary — permissions gate tool access, inference scope gates reasoning context |
| `@koi/redaction` | Complementary — redaction masks secrets in output, scope prevents cross-tenant reasoning |
| `@koi/middleware-exfiltration-guard` | Complementary — exfiltration guard catches encoded secrets, scope prevents context leakage |
| Nexus ReBAC | Layered — Nexus controls resource access, scope controls inference boundaries |
| ATIF traces | Extended — scope tags added as `extra` fields on trajectory steps |

---

## Open Questions

1. **Scope inheritance for spawned agents:** When a parent agent spawns a child, does the
   child inherit the parent's inference scope, or can it be narrowed?

2. **Cross-scope override:** Should there be a mechanism for explicit cross-scope access
   (e.g., a compliance officer reviewing cross-client patterns)? If so, what approval
   flow is required?

3. **Scope tag provenance:** How to prevent an agent from self-assigning a broader scope
   than its manifest allows? (Answer: L1 engine sets scope from manifest, not from
   agent input.)

4. **Performance impact:** Scope filtering at retrieval time adds a predicate to every
   memory/decision query. How to index efficiently in Nexus?

5. **Migration:** Existing unscoped traces need a default scope assignment. Options:
   a. Assign `{ tenant: "default" }` to all legacy traces
   b. Require explicit backfill before enabling scope enforcement
   c. Fail-open for unscoped traces during migration window

---

## Implementation Phases

| Phase | Scope | Deliverables |
|-------|-------|-------------|
| Phase 2 (current) | Design | This document, `InferenceScope` and `ScopeFilter` types in L0 |
| Phase 3 | Implementation | Scope tag recording in ATIF, `@koi/middleware-inference-scope`, scope-filtered retrieval in `@koi/memory` |
| Phase 4 | Nexus integration | Scope-aware ReBAC predicates, cross-scope audit dashboard |
