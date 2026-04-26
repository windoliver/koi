# @koi/forge-types — Shared Type + Contract Surfaces for the Forge Subsystem

**Layer:** L0-utility (L0u) — depends on `@koi/core` only.

`@koi/forge-types` is the shared type surface consumed by every L2 forge package
(`@koi/forge-tools`, `@koi/forge-demand`, `@koi/forge-verifier`, `@koi/forge-policy`,
`@koi/forge-integrity`, `@koi/forge-optimizer`, `@koi/forge-exaptation`,
`@koi/crystallize`, `@koi/harness-synth`, `@koi/harness-search`).

It is **types-only** — no runtime logic, no side effects. Pure type guards and
discriminated-union helpers are the only permitted runtime exports.

---

## Why it exists

L2 forge packages cannot import from peer L2 packages (layer rule). They share a
substantial type vocabulary — candidates, demands, artifacts, policy verdicts,
lifecycle states, observability events. Hoisting that vocabulary into an L0u
package lets every forge package depend on it without violating L2 isolation.

This package replaces the v1 monolithic `@koi/forge-types` package
(`archive/v1/packages/forge/forge-types`, ~1.3K LOC) with a **slim** v2 surface
(~200 LOC) focused on the four concept families called out in v2 issue #1343:

1. Demand → Candidate → Artifact pipeline types
2. Policy verdicts
3. Forge process lifecycle
4. Forge events for observability

Concrete details (4-stage verification reports, attestation envelopes,
governance backends, drift checking, etc.) belong inside the L2 package that
owns them. Only the **handoff types** between L2 packages live here.

---

## Concept map

```
ForgeDemand ──► ForgeCandidate ──► ForgeArtifact
   (signal)        (proposal)         (verified output)

ForgePolicy ─── verdict ───► allow | deny | require-approval

ForgeLifecycle: detected → proposed → synthesizing → verifying → published | failed | retired

ForgeEvent: discriminated union covering all of the above for telemetry
```

The single primary axis is the **forge process lifecycle**. Every other type
either feeds it (`ForgeDemand`, `ForgeCandidate`), is the result of a stage
(`ForgeArtifact`, `ForgePolicyVerdict`), or observes it (`ForgeEvent`).

---

## Public surface

### `ForgeDemand`

A passively-detected signal that a forge would be useful. Wraps the L0
`ForgeDemandSignal` from `@koi/core` and adds tracking state:

```ts
interface ForgeDemand {
  readonly signal: ForgeDemandSignal; // from @koi/core
  readonly status: "open" | "accepted" | "rejected" | "expired";
  readonly observedAt: number;
  readonly resolvedAt?: number | undefined;
  /** Number of times this trigger has been seen — drives priority. */
  readonly occurrences: number;
}
```

### `ForgeCandidate`

A proposal to forge a specific brick. Produced by demand → candidate logic
(see `@koi/forge-demand`); consumed by `@koi/forge-tools`.

```ts
interface ForgeCandidate {
  readonly id: string;
  readonly kind: BrickKind;          // tool | skill | agent | middleware | channel | composite
  readonly name: string;
  readonly description: string;
  readonly demandId?: string | undefined; // if pull-driven
  readonly priority: number;         // 0..1
  readonly proposedScope: ForgeScope;
  readonly createdAt: number;
}
```

### `ForgeArtifact`

The successful output of the forge pipeline. Wraps an L0 `BrickArtifact` and
adds forge-specific metadata (which candidate produced it, lifecycle state,
verification summary).

```ts
interface ForgeArtifact {
  readonly brick: BrickArtifact;     // from @koi/core
  readonly candidateId: string;
  readonly lifecycle: ForgeLifecycleState;
  readonly verification: ForgeVerificationSummary;
  readonly forgedAt: number;
  readonly forgedBy: string;         // agent ID
}

interface ForgeVerificationSummary {
  readonly passed: boolean;
  readonly stagesPassed: readonly string[];
  readonly stagesFailed: readonly string[];
  readonly durationMs: number;
}
```

### `ForgePolicy` + `ForgePolicyVerdict`

Configuration that the policy engine evaluates against a candidate, and the
verdict it produces:

```ts
interface ForgePolicy {
  readonly allowedKinds: readonly BrickKind[];
  readonly maxScope: ForgeScope;
  readonly budget: ForgeBudget;      // from @koi/core
  readonly requireApprovalAtOrAbove: ForgeScope;
}

type ForgePolicyVerdict =
  | { readonly decision: "allow" }
  | { readonly decision: "require-approval"; readonly reason: string }
  | { readonly decision: "deny"; readonly reason: string };
```

### `ForgeLifecycleState`

The forge **process** lifecycle (distinct from `BrickLifecycle`, which tracks
the brick after publication). Linear-with-failures:

```ts
type ForgeLifecycleState =
  | "detected"        // demand signal recorded
  | "proposed"        // candidate created
  | "synthesizing"    // tool generating implementation
  | "verifying"       // verifier pipeline running
  | "published"       // artifact added to brick store
  | "failed"          // pipeline aborted
  | "retired";        // retracted / deprecated
```

### Forge tool/middleware contracts

Minimal handoff shapes for forge tools and the demand-detection middleware.
Implementations live in L2 packages; only the input/output contracts live here.

```ts
interface ForgeToolInput {
  readonly kind: BrickKind;
  readonly name: string;
  readonly description: string;
  readonly spec: Readonly<Record<string, unknown>>;
  readonly scope?: ForgeScope | undefined;
}

interface ForgeToolResult {
  readonly ok: boolean;
  readonly artifact?: ForgeArtifact | undefined;
  readonly error?: string | undefined;
}

interface ForgeMiddlewareConfig {
  readonly enabled: boolean;
  readonly emitDemand: boolean;
  readonly autoSynthesize: boolean;
}
```

### `ForgeEvent`

Discriminated union for observability. Every L2 forge package emits these via
the standard event bus; UIs and audit sinks consume them:

```ts
type ForgeEvent =
  | { readonly kind: "demand_detected"; readonly demand: ForgeDemand }
  | { readonly kind: "candidate_proposed"; readonly candidate: ForgeCandidate }
  | { readonly kind: "synthesize_started"; readonly candidateId: string }
  | { readonly kind: "verify_started"; readonly candidateId: string }
  | {
      readonly kind: "forge_completed";
      readonly candidateId: string;
      readonly artifact: ForgeArtifact;
    }
  | {
      readonly kind: "forge_failed";
      readonly candidateId: string;
      readonly stage: ForgeLifecycleState;
      readonly reason: string;
    }
  | {
      readonly kind: "policy_decision";
      readonly candidateId: string;
      readonly verdict: ForgePolicyVerdict;
    };
```

### Type guards

Pure runtime helpers used by every L2 forge package:

- `isForgeLifecycleState(value: string): value is ForgeLifecycleState`
- `isTerminalForgeLifecycle(state: ForgeLifecycleState): boolean` — `published | failed | retired`
- `isForgeEvent(value: unknown): value is ForgeEvent` — exhaustive kind check

---

## Anti-leak rules

- No imports outside `@koi/core` (verified by `bun run check:layers`).
- No vendor types. The package is framework-agnostic.
- No runtime mutation. Every interface property is `readonly`; every array is
  `readonly T[]`.
- The exhaustive `ForgeEvent` union means adding a new event kind is a typed
  breaking change — intentional, because consumers must update their switches.

---

## Test plan

`src/types.test.ts` covers:

- Each interface satisfies its expected shape at runtime (literal value typed
  as the interface).
- Discriminated unions narrow correctly (compiles + branches).
- `isForgeLifecycleState` accepts every valid state and rejects unknown values.
- `isTerminalForgeLifecycle` is true for `published | failed | retired` only.
- `isForgeEvent` rejects malformed objects and accepts every valid `kind`.
