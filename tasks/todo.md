# Issue #223: Proposal + ProposalGate — Unified Change Governance

Agent-submitted change requests for any layer, with trust gates that scale with blast radius.

## Decisions Log

| # | Area | Issue | Decision | Choice |
|---|------|-------|----------|--------|
| 1 | Architecture | ProposalGate location | L0 only | **1A**: Both `Proposal` type and `ProposalGate` interface in `@koi/core`. L1 reads it like GovernanceController. |
| 2 | Architecture | Blast radius encoding | Pure data constant | **2A**: `PROPOSAL_GATE_REQUIREMENTS: Record<ChangeTarget, GateRequirement>` in L0 (like `MIN_TRUST_BY_KIND`). |
| 3 | Architecture | ProposalGate surface | Narrow | **3A**: `submit + review + watch` only. |
| 4 | Architecture | Relation to ApprovalRequest | Fully separate | **4A**: Distinct contract — different lifecycle, reviewer, and data model. |
| 5 | Code Quality | ChangeTarget modeling | Flat string union | **5A**: One value per gate tier: `"brick:sandboxed" \| "brick:promoted" \| "bundle_l2" \| "l1_extension" \| "l1_core" \| "l0_interface" \| "sandbox_policy" \| "gateway_routing"`. Renamed brick variants to match TrustTier vocabulary. |
| 6 | Code Quality | ReviewDecision vocabulary | "approved"/"rejected" | **6A**: `{ kind: "approved", reason? } \| { kind: "rejected", reason }`. Distinct from `ApprovalDecision`. |
| 7 | Code Quality | ProposalId type | Branded string | **7A**: `Brand<string, "ProposalId">` + `proposalId()` factory. |
| 8 | Code Quality | File organization | New file | **8A**: New `proposal.ts`. Do not extend `governance.ts` or `forge-types.ts`. |
| 9 | Tests | ChangeTarget exhaustiveness | Runtime + types | **9A**: Runtime loop over `ALL_CHANGE_TARGETS` + `Record<ChangeTarget, GateRequirement>` compile-time. |
| 10 | Tests | ProposalGate conformance | Stub + satisfies | **10A**: Async stubs with `satisfies ProposalGate`. Follows `ReputationBackend` test pattern. |
| 11 | Tests | ProposalStatus coverage | All variants | **11A**: Explicit test per status variant (pending, approved, rejected, superseded, expired). |
| 12 | Tests | PROPOSAL_GATE_REQUIREMENTS | Frozen + presence + key invariants | **12A**: Frozen + all 8 targets present + `brick:sandboxed` has no HITL + `l0_interface` requires HITL+fullTest. |
| 13 | Performance | submit/review return type | T \| Promise<T> | **13A**: `ProposalResult \| Promise<ProposalResult>` and `void \| Promise<void>`. |
| 14 | Performance | Proposal TTL field | Optional expiresAt | **14A**: `readonly expiresAt?: number \| undefined`. |
| 15 | Performance | Watch callback | void \| Promise<void> | **15A**: `(event: ProposalEvent) => void \| Promise<void>`. |
| 16 | Performance | Unsubscribe type | Plain function | **16A**: `ProposalUnsubscribe = () => void`. Consistent with `ConfigUnsubscribe`. |

---

## Phase 1: Create `proposal.ts` (L0 types)

**File**: `packages/core/src/proposal.ts`

### 1.1 Branded ProposalId + factory
- [ ] `declare const __proposalBrand: unique symbol`
- [ ] `type ProposalId = string & { readonly [__proposalBrand]: "ProposalId" }`
- [ ] `function proposalId(raw: string): ProposalId` — identity cast factory

### 1.2 ChangeTarget string union (8 gate tiers from arch doc table)
```typescript
type ChangeTarget =
  | "brick:sandboxed"   // tool, skill — matches TrustTier "sandbox", auto verified
  | "brick:promoted"    // middleware, channel — matches TrustTier "promoted", HITL required
  | "bundle_l2"         // fork to forge store, shadows bundled L2 — auto
  | "l1_extension"      // HITL + full agent test, takes effect at next startup
  | "l1_core"           // HITL + full agent test, requires new binary
  | "l0_interface"      // HITL + all agents test, requires new binary
  | "sandbox_policy"    // HITL + meta-sandbox test, config push
  | "gateway_routing";  // HITL + staging gateway test, config push
```
- [ ] `const ALL_CHANGE_TARGETS: readonly ChangeTarget[]` — for test exhaustiveness

### 1.3 ChangeKind string union
```typescript
type ChangeKind = "create" | "update" | "promote" | "delete" | "configure" | "extend";
```

### 1.4 ProposalStatus discriminated union (5 states)
```typescript
type ProposalStatus = "pending" | "approved" | "rejected" | "superseded" | "expired";
```

### 1.5 GateRequirement interface (per-tier requirements)
```typescript
interface GateRequirement {
  readonly requiresHitl: boolean;
  readonly requiresFullTest: boolean;
  readonly takeEffectOn: "immediately" | "next_session" | "next_startup" | "next_binary" | "config_push";
  readonly sandboxTestScope:
    | "brick_only"
    | "brick_plus_integration"
    | "full_agent_test"
    | "all_agents_test"
    | "meta_sandbox"
    | "staging_gateway";
}
```

### 1.6 PROPOSAL_GATE_REQUIREMENTS constant
```typescript
const PROPOSAL_GATE_REQUIREMENTS: Readonly<Record<ChangeTarget, GateRequirement>> = Object.freeze({
  "brick:sandboxed":  { requiresHitl: false, requiresFullTest: false, takeEffectOn: "immediately", sandboxTestScope: "brick_only" },
  "brick:promoted":   { requiresHitl: true,  requiresFullTest: false, takeEffectOn: "next_session", sandboxTestScope: "brick_plus_integration" },
  "bundle_l2":        { requiresHitl: false, requiresFullTest: false, takeEffectOn: "immediately", sandboxTestScope: "brick_only" },
  "l1_extension":     { requiresHitl: true,  requiresFullTest: true,  takeEffectOn: "next_startup", sandboxTestScope: "full_agent_test" },
  "l1_core":          { requiresHitl: true,  requiresFullTest: true,  takeEffectOn: "next_binary", sandboxTestScope: "full_agent_test" },
  "l0_interface":     { requiresHitl: true,  requiresFullTest: true,  takeEffectOn: "next_binary", sandboxTestScope: "all_agents_test" },
  "sandbox_policy":   { requiresHitl: true,  requiresFullTest: false, takeEffectOn: "config_push", sandboxTestScope: "meta_sandbox" },
  "gateway_routing":  { requiresHitl: true,  requiresFullTest: false, takeEffectOn: "config_push", sandboxTestScope: "staging_gateway" },
}) satisfies Record<ChangeTarget, GateRequirement>;
```

### 1.7 ReviewDecision discriminated union
```typescript
type ReviewDecision =
  | { readonly kind: "approved"; readonly reason?: string | undefined }
  | { readonly kind: "rejected"; readonly reason: string };  // reason required on rejection
```

### 1.8 ProposalEvent discriminated union (4 kinds)
```typescript
type ProposalEvent =
  | { readonly kind: "proposal:submitted"; readonly proposal: Proposal }
  | { readonly kind: "proposal:reviewed"; readonly proposalId: ProposalId; readonly decision: ReviewDecision }
  | { readonly kind: "proposal:expired"; readonly proposalId: ProposalId }
  | { readonly kind: "proposal:superseded"; readonly proposalId: ProposalId; readonly supersededBy: ProposalId };
```

### 1.9 ProposalInput interface (what submitter provides)
```typescript
interface ProposalInput {
  readonly submittedBy: AgentId;
  readonly changeTarget: ChangeTarget;
  readonly changeKind: ChangeKind;
  readonly description: string;
  readonly brickRef?: BrickRef | undefined;
  readonly expiresAt?: number | undefined;
  readonly metadata?: JsonObject | undefined;
}
```

### 1.10 Proposal interface (gate assigns id, status, submittedAt)
```typescript
interface Proposal {
  readonly id: ProposalId;
  readonly submittedBy: AgentId;
  readonly changeTarget: ChangeTarget;
  readonly changeKind: ChangeKind;
  readonly description: string;
  readonly brickRef?: BrickRef | undefined;
  readonly status: ProposalStatus;
  readonly submittedAt: number;
  readonly expiresAt?: number | undefined;
  readonly reviewedAt?: number | undefined;
  readonly reviewDecision?: ReviewDecision | undefined;
  /** Set when status is "superseded" — points to the replacing proposal. */
  readonly supersededBy?: ProposalId | undefined;
  readonly metadata?: JsonObject | undefined;
}
```

### 1.11 ProposalResult + ProposalUnsubscribe types
```typescript
type ProposalResult = Result<Proposal, KoiError>;
type ProposalUnsubscribe = () => void;
```

### 1.12 ProposalGate interface (narrow: submit + review + watch)
```typescript
interface ProposalGate {
  readonly submit: (input: ProposalInput) => ProposalResult | Promise<ProposalResult>;
  readonly review: (id: ProposalId, decision: ReviewDecision) => void | Promise<void>;
  readonly watch: (
    handler: (event: ProposalEvent) => void | Promise<void>,
  ) => ProposalUnsubscribe;
}
```

### 1.13 Imports
```typescript
import type { AgentId } from "./ecs.js";
import type { BrickRef } from "./brick-snapshot.js";
import type { JsonObject } from "./common.js";
import type { KoiError, Result } from "./errors.js";
```

### 1.14 L0 anti-leak verification
- [ ] No `import` from any `@koi/*` package (only intra-L0 `.js` imports)
- [ ] No function bodies except branded type constructor + data constants
- [ ] All interface properties are `readonly`
- [ ] Uses `.js` extensions in all import paths (ESM)

---

## Phase 2: Create `proposal.test.ts` (colocated unit tests)

**File**: `packages/core/src/proposal.test.ts`

### 2.1 `proposalId()` factory tests
- [ ] `proposalId("test-123")` returns branded string
- [ ] `typeof id === "string"` (structural string check)
- [ ] Same input produces same output (`expect(id).toBe(proposalId("test-123"))`)

### 2.2 `ALL_CHANGE_TARGETS` exhaustiveness test
- [ ] Has exactly 8 entries
- [ ] All 8 expected values are present
- [ ] Is frozen / readonly (attempt mutation fails or array is frozen)

### 2.3 `PROPOSAL_GATE_REQUIREMENTS` constant tests
- [ ] Is frozen (`Object.isFrozen(PROPOSAL_GATE_REQUIREMENTS)`)
- [ ] All `ALL_CHANGE_TARGETS` values have an entry (runtime loop)
- [ ] `"brick:sandboxed"` has `requiresHitl: false` (lowest blast radius gate)
- [ ] `"l0_interface"` has `requiresHitl: true` AND `requiresFullTest: true` (highest blast radius)
- [ ] `"brick:sandboxed"` has `takeEffectOn: "immediately"`
- [ ] `"l0_interface"` has `sandboxTestScope: "all_agents_test"`

### 2.4 `ReviewDecision` discriminated union tests
- [ ] `approved` variant: `{ kind: "approved" }` compiles, `reason` is optional
- [ ] `approved` with reason: `{ kind: "approved", reason: "LGTM" }` compiles
- [ ] `rejected` variant: `{ kind: "rejected", reason: "security risk" }` compiles
- [ ] `rejected` requires `reason` field (TypeScript compile-time — comment explaining it)

### 2.5 `ProposalStatus` variant tests
- [ ] `"pending"` variant: typed Proposal stub with `status: "pending"` compiles
- [ ] `"approved"` variant: `status: "approved"` compiles
- [ ] `"rejected"` variant: `status: "rejected"` compiles
- [ ] `"superseded"` variant: `status: "superseded"` compiles
- [ ] `"expired"` variant: `status: "expired"` compiles

### 2.6 `ProposalEvent` discriminated union tests (follow SnapshotEvent pattern)
- [ ] `"proposal:submitted"` variant
- [ ] `"proposal:reviewed"` variant with approved decision
- [ ] `"proposal:expired"` variant
- [ ] `"proposal:superseded"` variant with `supersededBy` field

### 2.7 `Proposal` interface shape test
- [ ] Full proposal compiles with all fields set
- [ ] Minimal proposal (no optional fields) compiles
- [ ] `brickRef`, `expiresAt`, `reviewedAt`, `reviewDecision`, `supersededBy`, `metadata` are all optional
- [ ] `supersededBy` field accepts a `ProposalId` value

### 2.8 `ProposalGate` interface conformance test (follows ReputationBackend pattern)
- [ ] Stub minimal implementation compiles with `satisfies ProposalGate`
- [ ] `submit` is a function
- [ ] `review` is a function
- [ ] `watch` is a function that returns a function (ProposalUnsubscribe)
- [ ] Optional: verify `watch` returns something callable (smoke test)

---

## Phase 3: Update `index.ts` exports

**File**: `packages/core/src/index.ts`

Add after `// forge types` section (alphabetically: "proposal" comes after "provenance"):

```typescript
// proposal — unified change governance contract
export type {
  ChangeKind,
  ChangeTarget,
  GateRequirement,
  Proposal,
  ProposalEvent,
  ProposalGate,
  ProposalId,
  ProposalInput,
  ProposalResult,
  ProposalStatus,
  ProposalUnsubscribe,
  ReviewDecision,
} from "./proposal.js";
export { ALL_CHANGE_TARGETS, PROPOSAL_GATE_REQUIREMENTS, proposalId } from "./proposal.js";
```

---

## Phase 4: Update API surface snapshot

- [ ] Run `bun run build` in `packages/core` (or `turbo build --filter=@koi/core`)
- [ ] Run `bun test packages/core/src/__tests__/api-surface.test.ts --update-snapshots`
- [ ] Verify snapshot diff is additive only (new proposal exports, nothing removed)

---

## Phase 5: Verify

- [ ] `bun run build` — clean compilation, zero TypeScript errors
- [ ] `bun test packages/core` — all tests pass including proposal.test.ts
- [ ] `bun run lint` — Biome passes, no formatting issues
- [ ] Coverage for proposal.ts >= 80% (all runtime code: factory + constant)
- [ ] Anti-leak: `@koi/core` has zero imports from other `@koi/*` packages
- [ ] No function bodies in proposal.ts except branded cast and data constants
- [ ] All interface properties are `readonly`
- [ ] No banned constructs: `enum`, `any`, `as Type`, `!`, `@ts-ignore`
- [ ] ESM-only with `.js` extensions in all imports

---

## Files Summary

| File | Action | Est. LOC | Purpose |
|------|--------|----------|---------|
| `packages/core/src/proposal.ts` | Create | ~195 | L0 types + constants + factory |
| `packages/core/src/proposal.test.ts` | Create | ~175 | All type-shape + constant tests |
| `packages/core/src/index.ts` | Modify | +15 lines | Export proposal types |
| `packages/core/src/__tests__/__snapshots__/api-surface.test.ts.snap` | Regenerate | — | Updated API surface |

**Total new code**: ~385 LOC (45% tests)
