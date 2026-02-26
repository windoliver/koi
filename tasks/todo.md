# Issue #357: Consolidate BrickKind from 9 to 5

Remove `engine`, `resolver`, `provider`, `composite` from BrickKind.
Remaining kinds: `tool`, `skill`, `middleware`, `channel`, `agent`.

## Decisions Log

| # | Decision | Choice |
|---|----------|--------|
| 1A | ImplementationArtifact | Narrow to `"middleware" \| "channel"` |
| 2A | L0 token factories | Remove `engineToken`, `resolverToken`, `providerToken` |
| 3A | brick-validation.ts | Remove `"composite"` from `VALID_KINDS` |
| 4A | IMPLEMENTATION_KINDS | Shrink set to `middleware` + `channel` |
| 5A | Dead input types | Delete 4 types from `types.ts`, narrow `ForgeInput` |
| 6A | Dead forge tool files | Delete all 8 files (~1,843 lines) |
| 7A | Exhaustive switches | Update all 5 files, maintain exhaustive matching |
| 8A | Dead exports | Remove all from `index.ts` |
| 9A | forge-types.test.ts | Rewrite for 5 kinds (not delete) |
| 10A | Dead test files | Delete 4 files |
| 11A | Impl tests | Rewrite for middleware+channel only |
| 12A | test-utils factories | Remove composite factory, update impl factory default |
| 13A | Storage migration | None needed (dead kinds never used in production) |
| 14A | E2E scripts | Update to remove dead imports |
| 15A | Build speedup | Enjoy the free lunch |
| 16A | Integration tests | Surgically remove 4 dead tests |

---

## Phase 1: L0 core types (`@koi/core`)

Smallest blast radius — pure type changes that propagate errors downstream.

- [ ] `packages/core/src/forge-types.ts` — BrickKind union: remove `composite`, `engine`, `resolver`, `provider`
- [ ] `packages/core/src/forge-types.ts` — ALL_BRICK_KINDS: remove 4 entries (9 → 5)
- [ ] `packages/core/src/forge-types.ts` — MIN_TRUST_BY_KIND: remove 4 entries, update JSDoc
- [ ] `packages/core/src/brick-store.ts` — Remove `CompositeArtifact` interface
- [ ] `packages/core/src/brick-store.ts` — Narrow `ImplementationArtifact.kind` to `"middleware" | "channel"`
- [ ] `packages/core/src/brick-store.ts` — Remove `CompositeArtifact` from `BrickArtifact` union
- [ ] `packages/core/src/ecs.ts` — Remove `engineToken()`, `resolverToken()`, `providerToken()` functions

## Phase 2: L2 forge types (`@koi/forge`)

Remove dead input types and narrow the discriminated union.

- [ ] `packages/forge/src/types.ts` — Delete `ForgeCompositeInput` (lines 134-144)
- [ ] `packages/forge/src/types.ts` — Delete `ForgeEngineInput` (lines 174-186)
- [ ] `packages/forge/src/types.ts` — Delete `ForgeResolverInput` (lines 188-200)
- [ ] `packages/forge/src/types.ts` — Delete `ForgeProviderInput` (lines 201-214)
- [ ] `packages/forge/src/types.ts` — Narrow `ForgeInput` union to 5 members
- [ ] `packages/forge/src/types.ts` — Remove dead re-exports (`CompositeArtifact`, `ImplementationArtifact` stays)

## Phase 3: Delete dead forge tool files

- [ ] Delete `packages/forge/src/tools/forge-engine.ts`
- [ ] Delete `packages/forge/src/tools/forge-engine.test.ts`
- [ ] Delete `packages/forge/src/tools/forge-resolver.ts`
- [ ] Delete `packages/forge/src/tools/forge-resolver.test.ts`
- [ ] Delete `packages/forge/src/tools/forge-provider.ts`
- [ ] Delete `packages/forge/src/tools/forge-provider.test.ts`
- [ ] Delete `packages/forge/src/tools/compose-forge.ts`
- [ ] Delete `packages/forge/src/tools/compose-forge.test.ts`
- [ ] `packages/forge/src/index.ts` — Remove 4 dead tool exports (createComposeForgeTool, createForgeEngineTool, createForgeProviderTool, createForgeResolverTool)
- [ ] `packages/forge/src/index.ts` — Remove dead type exports (ForgeCompositeInput, ForgeEngineInput, ForgeProviderInput, ForgeResolverInput, CompositeArtifact)

## Phase 4: Update L2 forge logic (exhaustive switches)

- [ ] `packages/forge/src/integrity.ts` — `extractContentForHash()`: remove engine/resolver/provider fall-through, remove composite case
- [ ] `packages/forge/src/forge-resolver.ts` — `extractSource()`: remove engine/resolver/provider fall-through, remove composite case
- [ ] `packages/forge/src/verify-static.ts` — Remove composite case, remove engine/resolver/provider from impl branch, delete `validateCompositeInput()`, narrow `ImplementationForgeInput`
- [ ] `packages/forge/src/verify-sandbox.ts` — Remove composite special case (lines 34-39)
- [ ] `packages/forge/src/verify-self-test.ts` — Simplify `hasTestCases` boolean (remove engine/resolver/provider)
- [ ] `packages/forge/src/forge-component-provider.ts` — Shrink `IMPLEMENTATION_KINDS` to 2, simplify `implementationToken()`, remove dead token imports
- [ ] `packages/forge/src/assemble-manifest.ts` — Remove composite case (lines 91-94)

## Phase 5: Update L0u validation

- [ ] `packages/validation/src/brick-validation.ts` — Remove `"composite"` from `VALID_KINDS`
- [ ] `packages/validation/src/brick-validation.ts` — Remove `"composite"` case from `validateKindFields()`

## Phase 6: Update test-utils

- [ ] `packages/test-utils/src/brick-artifacts.ts` — Delete `createTestCompositeArtifact()`
- [ ] `packages/test-utils/src/brick-artifacts.ts` — Update `createTestImplementationArtifact()` default kind from `"engine"` to `"middleware"`
- [ ] `packages/test-utils/src/index.ts` — Remove `createTestCompositeArtifact` export

## Phase 7: Update tests

- [ ] `packages/core/src/__tests__/forge-types.test.ts` — Rewrite: 5 kinds, updated trust tier assertions
- [ ] `packages/core/src/__tests__/exports.test.ts` — Remove dead type refs and runtime checks
- [ ] `packages/forge/src/forge-component-provider.test.ts` — Remove engine/resolver/provider assertions, update helpers
- [ ] `packages/forge/src/__tests__/forge-nontools-integration.test.ts` — Remove 4 dead integration tests (~125 lines)
- [ ] `packages/validation/src/brick-validation.test.ts` — Remove composite test and helper
- [ ] `packages/forge/src/integrity.test.ts` — Remove composite helpers and assertions

## Phase 8: Update E2E scripts

- [ ] `scripts/e2e-forge.ts` — Remove `createComposeForgeTool` import and composite scenarios
- [ ] `scripts/e2e-scope-enforcement-pi.ts` — Remove `createComposeForgeTool` import and usage

## Phase 9: Verify

- [ ] Run `bun run build` — clean compilation
- [ ] Run `bun test` — all tests pass
- [ ] Run `bun run lint` — Biome passes
- [ ] Verify test coverage >= 80%
- [ ] Anti-leak: `@koi/core` has zero imports from other packages
- [ ] Anti-leak: L2 packages only import from L0 and L0u
- [ ] Confirm no dead kind references remain in `packages/`

---

## Files Summary

### Deleted (~1,843 lines)
- `packages/forge/src/tools/forge-engine.ts`
- `packages/forge/src/tools/forge-engine.test.ts`
- `packages/forge/src/tools/forge-resolver.ts`
- `packages/forge/src/tools/forge-resolver.test.ts`
- `packages/forge/src/tools/forge-provider.ts`
- `packages/forge/src/tools/forge-provider.test.ts`
- `packages/forge/src/tools/compose-forge.ts`
- `packages/forge/src/tools/compose-forge.test.ts`

### Modified (L0)
- `packages/core/src/forge-types.ts`
- `packages/core/src/brick-store.ts`
- `packages/core/src/ecs.ts`

### Modified (L2)
- `packages/forge/src/types.ts`
- `packages/forge/src/index.ts`
- `packages/forge/src/integrity.ts`
- `packages/forge/src/forge-resolver.ts`
- `packages/forge/src/verify-static.ts`
- `packages/forge/src/verify-sandbox.ts`
- `packages/forge/src/verify-self-test.ts`
- `packages/forge/src/forge-component-provider.ts`
- `packages/forge/src/assemble-manifest.ts`

### Modified (L0u)
- `packages/validation/src/brick-validation.ts`
- `packages/test-utils/src/brick-artifacts.ts`
- `packages/test-utils/src/index.ts`

### Modified (Tests)
- `packages/core/src/__tests__/forge-types.test.ts`
- `packages/core/src/__tests__/exports.test.ts`
- `packages/forge/src/forge-component-provider.test.ts`
- `packages/forge/src/__tests__/forge-nontools-integration.test.ts`
- `packages/validation/src/brick-validation.test.ts`
- `packages/forge/src/integrity.test.ts`

### Modified (E2E)
- `scripts/e2e-forge.ts`
- `scripts/e2e-scope-enforcement-pi.ts`
