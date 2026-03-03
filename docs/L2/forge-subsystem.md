# Forge Subsystem — Package Architecture

The forge subsystem is split into focused packages that respect Koi's layered architecture.
No L2 package imports from a peer L2 — cross-package calls use dependency injection via
the `ForgePipeline` interface.

## Package Map

```
@koi/forge-types    (L0u)  Shared types, errors, config, ForgePipeline interface
@koi/forge-verifier (L2)   4-stage verification pipeline, workspace management
@koi/forge-integrity(L2)   Attestation, provenance, SLSA, content-addressed hashing
@koi/forge-policy   (L2)   Governance, usage tracking, drift detection
@koi/forge-tools    (L2)   Primordial tools, component provider, resolver
@koi/forge          (L3)   Re-export bundle + composition root
```

## Dependency Graph

```
                    @koi/core (L0)
                        |
                  @koi/forge-types (L0u)
                   /    |    |    \
           verifier  integrity  policy  tools   (all L2, independent)
                   \    |    |    /
                    @koi/forge (L3)   <-- wires everything via createForgePipeline()
```

## How It Works

The key problem: `forge-tools` needs to call `verify()` (in forge-verifier),
`checkGovernance()` (in forge-policy), and `createForgeProvenance()` (in forge-integrity).
But L2 packages cannot import from peer L2 packages.

Solution: **dependency injection via `ForgePipeline`**.

```typescript
// 1. ForgePipeline interface is defined in @koi/forge-types (L0u)
//    Both forge-tools and the L3 bundle can see it.

interface ForgePipeline {
  readonly verify: (...) => Promise<Result<VerificationReport, ForgeError>>;
  readonly checkGovernance: (...) => Result<void, ForgeError>;
  readonly createProvenance: (...) => ForgeProvenance;
  // ... more methods
}

// 2. The L3 bundle wires concrete implementations
import { verify } from "@koi/forge-verifier";
import { checkGovernance } from "@koi/forge-policy";
import { createForgeProvenance } from "@koi/forge-integrity";

function createForgePipeline(): ForgePipeline {
  return { verify, checkGovernance, createProvenance: createForgeProvenance, ... };
}

// 3. Tools receive the pipeline via ForgeDeps
const deps: ForgeDeps = {
  store, executor, pipeline: createForgePipeline(), ...
};
const tool = createForgeToolTool(deps);
```

## What Each Package Does

### @koi/forge-types (L0u) — ~1,200 LOC

Shared types consumed by all forge packages:

- `ForgeInput`, `ForgeResult`, `ForgeContext` — pipeline I/O types
- `ForgeError` — discriminated union with error factories (`staticError`, `storeError`, etc.)
- `ForgeConfig` — configuration with Zod validation
- `ForgePipeline` — DI interface for cross-package operations
- `VerificationReport`, `StageReport` — verification output types
- Scope filter functions (`isVisibleToAgent`, `filterByAgentScope`)
- Reverification TTL computation (`computeTtl`, `isStale`)

### @koi/forge-verifier (L2) — ~3,600 LOC

The 4-stage verification pipeline:

| Stage | Function | What it checks |
|-------|----------|----------------|
| 1 | `verifyStatic` | Schema validation, banned patterns, code analysis |
| 1.25 | `verifyFormat` | Auto-formatting normalization |
| 1.5 | `verifyResolve` | Dependency resolution |
| 2 | `verifySandbox` | Sandbox execution with tiered executor |
| 3 | `verifySelfTest` | Self-test + pluggable adversarial verifiers |
| 4 | `assignTrust` | Trust tier assignment based on results |

Also includes:
- `createBrickWorkspace` — isolated npm workspace creation with caching
- `createAdversarialVerifiers` — injection/exfiltration/resource exhaustion probes
- `generateTestCases` — CDGP-based automatic test generation
- `compileBrickModule` — content-addressed module writer

### @koi/forge-integrity (L2) — ~660 LOC

Content-addressed identity and cryptographic provenance:

- `createForgeProvenance` — build SLSA v1.0 provenance from pipeline outputs
- `signAttestation` / `verifyAttestation` — cryptographic signing via `SigningBackend`
- `verifyBrickIntegrity` — content-hash verification
- `verifyBrickAttestation` — full integrity + signature verification
- `mapProvenanceToSlsa` — SLSA v1.0 predicate serialization
- `createAttestationCache` — LRU cache for verification results

### @koi/forge-policy (L2) — ~1,160 LOC

Governance rules and usage tracking:

- `checkGovernance` — depth-aware forge budget enforcement
- `checkScopePromotion` — scope promotion rules (agent → zone → global)
- `validateTrustTransition` — trust tier transition validation
- `checkMutationPressure` — capability space governance
- `recordBrickUsage` / `computeAutoPromotion` — usage-based auto-promotion
- `createDriftChecker` — source file staleness detection
- `createReverificationQueue` — bounded-concurrency re-verification
- `createForgeSessionCounter` — per-session forge budget tracking

### @koi/forge-tools (L2) — ~4,000 LOC

The primordial forge tools that agents call:

| Tool | What it creates |
|------|----------------|
| `forge_tool` | Runtime tool (function + schema) |
| `forge_skill` | Skill (prompt template) |
| `forge_agent` | Sub-agent (manifest) |
| `forge_middleware` | Middleware implementation |
| `forge_channel` | Channel implementation |
| `compose_forge` | Pipeline composition (A→B→C) |
| `promote_forge` | Scope/trust/lifecycle promotion |
| `search_forge` | Brick discovery |
| `forge_edit` | Search-and-replace editing |

Also includes:
- `createForgeComponentProvider` — ECS component provider for forge bricks
- `createForgeResolver` — forge-aware brick resolver with drift checking
- `createInMemoryForgeStore` — in-memory ForgeStore for testing

### @koi/forge (L3) — Composition Root

The L3 bundle re-exports everything from all sub-packages plus:

- `createForgePipeline()` — wires all L2 implementations into ForgePipeline
- `createForgeRuntime()` — hot-attach runtime with caching and integrity checks

## When to Import From Where

| You need... | Import from |
|------------|-------------|
| Types only (ForgeError, ForgeConfig, etc.) | `@koi/forge-types` |
| Just verification | `@koi/forge-verifier` |
| Just attestation/integrity | `@koi/forge-integrity` |
| Just governance/usage | `@koi/forge-policy` |
| Just tools/store/resolver | `@koi/forge-tools` |
| Everything (backward compat) | `@koi/forge` |
| Wired pipeline + runtime | `@koi/forge` (L3 only) |
