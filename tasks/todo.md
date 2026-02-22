# Forge Phase 2: Full Bricks — `forge_skill`, `forge_agent`, `compose_forge`

## Overview

Implement the remaining 3 primordial forge tools (`forge_agent`, `compose_forge`, `promote_forge`) plus
foundation fixes identified during architecture/code/test/performance review.

All decisions are documented in the review conversation and summarized below.

---

## Phase A: Foundation (pre-requisites for Phase 2 tools)

These changes fix existing issues and prepare the codebase for the new tools.

### A1. Refactor `BrickArtifact` to discriminated union
- [ ] Define `BrickArtifactBase` with common fields (id, kind, name, description, scope, trustTier, lifecycle, createdBy, createdAt, version, tags, usageCount)
- [ ] Define `ToolArtifact` = base + `implementation`, `inputSchema`, `testCases?`
- [ ] Define `SkillArtifact` = base + `content`
- [ ] Define `AgentArtifact` = base + `manifestYaml`
- [ ] Define `CompositeArtifact` = base + `brickIds`
- [ ] Type alias `BrickArtifact = ToolArtifact | SkillArtifact | AgentArtifact | CompositeArtifact`
- [ ] Update `ForgeStore`, `InMemoryForgeStore`, `BrickUpdate` to use the union
- [ ] Update `forge-tool.ts`, `forge-skill.ts` to construct kind-specific artifacts
- [ ] Update `forge-component-provider.ts` to narrow via `kind === "tool"`
- [ ] Update `search-forge.ts`, `forge-resolver.ts` for the new type
- [ ] Update all tests — the `createBrick()` helper needs kind-specific factory variants
- [ ] Ensure all existing 172 tests still pass

### A2. Extract shared forge pipeline (`runForgePipeline`)
- [ ] Create `runForgePipeline(forgeInput, deps, buildArtifact)` in `shared.ts`
  - Steps: verify → generate ID → buildArtifact callback → save → build ForgeResult
- [ ] Refactor `forge-tool.ts` handler to use pipeline (validate + construct input + call pipeline)
- [ ] Refactor `forge-skill.ts` handler to use pipeline
- [ ] Verify no behavior change — all existing tests pass

### A3. Add `INVALID_TYPE` error code
- [ ] Add `"INVALID_TYPE"` to the `ForgeError` static stage union in `errors.ts`
- [ ] Add `typeError()` factory function
- [ ] Update `validateInputFields()` in `shared.ts` to use `INVALID_TYPE` for type mismatches
- [ ] Keep `MISSING_FIELD` only for `value === undefined`
- [ ] Update test assertions that check for `MISSING_FIELD` on type mismatches

### A4. Fix `ForgeResolver.discover()` silent error swallowing
- [ ] In `forge-resolver.ts`, change `discover()` to throw on store failure:
  ```typescript
  if (!result.ok) {
    throw new Error(`ForgeResolver: store search failed: ${result.error.message}`, { cause: result.error });
  }
  ```
- [ ] Add test for the throw behavior

### A5. Implement depth-aware tool filtering in governance
- [ ] Define `DEPTH_ALLOWED_TOOLS` constant mapping depth → allowed tool names:
  - Depth 0: all 6 tools
  - Depth 1: `forge_tool`, `forge_skill`, `search_forge`, `promote_forge`
  - Depth 2+: `search_forge` only
- [ ] Extend `checkGovernance()` to accept `toolName: string` parameter
- [ ] Check `toolName` against `DEPTH_ALLOWED_TOOLS[Math.min(depth, 2)]`
- [ ] Add new governance error code: `"DEPTH_TOOL_RESTRICTED"` (add to `ForgeError` union)
- [ ] Update `createForgeTool()` in `shared.ts` to pass tool name to governance
- [ ] Write tests:
  - Depth 0 allows forge_agent ✓
  - Depth 1 rejects forge_agent with DEPTH_TOOL_RESTRICTED ✓
  - Depth 1 allows forge_tool ✓
  - Depth 2 rejects forge_tool, allows search_forge ✓

### A6. Add `search_forge` store failure test
- [ ] In `search-forge.test.ts`, add test with failing store
- [ ] Verify error propagates with stage "store" and code "SEARCH_FAILED"

### A7. Add fail-fast option to Stage 3 test case execution
- [ ] Add `failFast?: boolean` to `VerificationConfig`
- [ ] In `verifySelfTest()`, break on first test failure when `failFast` is true
- [ ] Default `failFast` to `true` in `DEFAULT_VERIFICATION`
- [ ] Add test for fail-fast behavior

---

## Phase B: `forge_agent` (TDD)

### B1. Define `ManifestParser` interface
- [ ] Add to `shared.ts` (or new `manifest-parser.ts`):
  ```typescript
  interface ManifestParseResult {
    readonly name: string;
    readonly description: string;
    readonly tools?: readonly string[];
    readonly channels?: readonly string[];
    readonly middleware?: readonly string[];
    readonly permissions?: unknown;
    readonly model?: unknown;
  }

  interface ManifestParser {
    readonly parse: (yaml: string) => Promise<Result<ManifestParseResult, KoiError>>;
  }
  ```
- [ ] Add `manifestParser?: ManifestParser` to `ForgeDeps` (optional — only needed by forge_agent)

### B2. Extend `verifyStatic` for agent manifests
- [ ] In `validateAgentInput()`, add manifest structure validation:
  - Parse YAML via injected parser (passed through a new config/context field)
  - Validate required manifest fields (name, at minimum)
  - No: actually static verification shouldn't need a parser — keep it to size/syntax checks
  - Manifest parsing happens in the handler, not in static verification
- [ ] Decision: Static verification keeps doing name/size checks. Manifest parsing is handler-level.

### B3. Write `forge_agent` tests (RED phase)
- [ ] Create `packages/forge/src/tools/forge-agent.test.ts`
- [ ] Tests to write:
  - `has correct descriptor` (name, description, trustTier)
  - `forges agent from valid manifest YAML → saves to store with kind "agent"`
  - `returns AgentArtifact with manifestYaml stored`
  - `returns verification report with sandbox/self-test skipped`
  - `returns error when ManifestParser rejects invalid YAML`
  - `returns error when manifest name is empty`
  - `returns error for size exceeding limit`
  - `returns store error on save failure`
  - `returns governance error at depth 1` (depth-aware filtering)
  - `returns governance error when forge disabled`
  - `runs ForgeVerifier[] on agent input`
  - `includes metadata (forgedBy, sessionId, depth)`

### B4. Implement `forge_agent` handler (GREEN phase)
- [ ] Replace stub in `forge-agent.ts` with full handler:
  1. Validate input fields (name, description, manifestYaml)
  2. Call `deps.manifestParser.parse(manifestYaml)` — fail if parser rejects
  3. Construct `ForgeAgentInput`
  4. Call `runForgePipeline()` with agent-specific artifact builder
  5. Artifact builder creates `AgentArtifact` with `manifestYaml`
- [ ] All B3 tests pass (GREEN)

### B5. Refactor `forge_agent` if needed (IMPROVE phase)
- [ ] Check code against code quality checklist
- [ ] Verify coverage ≥ 80%

---

## Phase C: `compose_forge` (TDD)

### C1. Write `compose_forge` tests (RED phase)
- [ ] Create `packages/forge/src/tools/compose-forge.test.ts`
- [ ] Tests to write:
  - `has correct descriptor`
  - `composes valid brick IDs → saves CompositeArtifact to store`
  - `returns error when brickIds is empty`
  - `returns error when referenced brick does not exist`
  - `returns error when referenced brick is not active (deprecated/failed)`
  - `returns error for circular reference (composite A → composite B → composite A)`
  - `returns error for self-reference (composite references itself — impossible at create but test defensively)`
  - `loads bricks in parallel (Promise.all)`
  - `returns store error on save failure`
  - `governance: rejected at depth 1`
  - `includes metadata`

### C2. Implement `compose_forge` handler (GREEN phase)
- [ ] Replace stub with full handler:
  1. Validate input fields (name, description, brickIds)
  2. Load all referenced bricks via `Promise.all(brickIds.map(id => deps.store.load(id)))`
  3. Validate all bricks exist and are `active`
  4. Detect circular references (if any referenced brick is a composite, check its brickIds recursively)
  5. Call `runForgePipeline()` with composite-specific artifact builder
  6. Artifact builder creates `CompositeArtifact` with `brickIds`
- [ ] All C1 tests pass (GREEN)

### C3. Refactor (IMPROVE phase)
- [ ] Check code quality
- [ ] Verify coverage ≥ 80%

---

## Phase D: `promote_forge` (TDD)

### D1. Design HITL approval flow
- [ ] `promote_forge` checks governance → if `requiresHumanApproval`, return a result indicating
  "pending_approval" rather than failing
- [ ] For now: the handler validates, updates the store, and returns a `GovernanceResult`
  with `requiresHumanApproval: true` in the metadata. Actual HITL delivery (gateway webhook,
  middleware interrupt) is out of scope for this PR.
- [ ] The handler CAN update scope/trust without actual HITL blocking — it returns the
  `requiresHumanApproval` flag so the caller/middleware can decide to block.

### D2. Write `promote_forge` tests (RED phase)
- [ ] Create `packages/forge/src/tools/promote-forge.test.ts`
- [ ] Tests to write:
  - `has correct descriptor`
  - `promotes brick from agent → zone scope (trust verified)`
  - `returns requiresHumanApproval when HITL is configured`
  - `rejects promotion when trust tier too low (SCOPE_VIOLATION)`
  - `rejects promotion to lower scope (no-op)`
  - `promotes trust tier from sandbox → verified`
  - `rejects promotion to promoted without HITL flag`
  - `returns NOT_FOUND when brick doesn't exist`
  - `updates store after successful promotion`
  - `governance: rejected when forge disabled`

### D3. Implement `promote_forge` handler (GREEN phase)
- [ ] Replace stub with full handler:
  1. Validate input (brickId required, targetScope/targetTrustTier optional)
  2. Load brick from store
  3. Call `checkScopePromotion()` for scope changes
  4. Update brick via `store.update()` with new scope/trustTier
  5. Return `ForgeResult`-like response with `GovernanceResult` for HITL flag
- [ ] All D2 tests pass

### D4. Write promote lifecycle integration test
- [ ] Add to `lifecycle.test.ts`:
  - Forge tool at agent scope → promote to zone → verify store updated
  - Attempt invalid promotion (sandbox trust → global scope) → SCOPE_VIOLATION
  - Verify requiresHumanApproval flag set when config requires it

---

## Phase E: Performance improvements

### E1. Lazy loading with cache for `ForgeComponentProvider`
- [ ] Change `createForgeComponentProviderAsync` to `createForgeComponentProvider` (sync factory)
- [ ] Lazy-load tools on first `attach()` call
- [ ] Cache loaded tools in a `Map`
- [ ] Add `refresh()` method to invalidate cache
- [ ] Update tests and consumers

### E2. Verify all tests pass and coverage ≥ 80%
- [ ] Run `bun test packages/forge/ --coverage`
- [ ] Ensure 172+ tests pass (including new ones)
- [ ] Line coverage ≥ 80% across all files

---

## Implementation Order

```
A1 (BrickArtifact union) → A2 (shared pipeline) → A3 (INVALID_TYPE) → A4 (resolver fix)
→ A5 (depth governance) → A6 (search test) → A7 (fail-fast)
→ B1-B5 (forge_agent TDD)
→ C1-C3 (compose_forge TDD)
→ D1-D4 (promote_forge TDD)
→ E1-E2 (performance)
```

Phases B, C, D are strictly sequential (each builds on the shared pipeline).
Phase A items are mostly independent and can be done in parallel where possible.
Phase E is independent and can happen after any other phase.

---

## Decision Log

| # | Issue | Decision | Rationale |
|---|-------|----------|-----------|
| 1 | L2 peer dep | Inject ManifestParser via ForgeDeps | Zero layer violations, testable |
| 2 | BrickArtifact shape | Discriminated union | Compile-time safety, Koi-idiomatic |
| 3 | compose_forge semantics | Metadata-only grouping | KISS, avoids premature runtime semantics |
| 4 | Agent verification | Static + pluggable verifiers | Safety floor + extensibility |
| 5 | DRY handlers | Extract shared pipeline | Rule of Three, ~15 lines per new handler |
| 6 | Error codes | Add INVALID_TYPE | Semantic correctness |
| 7 | Error swallowing | Throw with cause | CLAUDE.md unexpected failure rules |
| 8 | Composite validation | Validate in handler | Fail-fast, handler has store access |
| 9 | forge_agent tests | TDD — tests first | CLAUDE.md mandate |
| 10 | search_forge gap | Add store failure test | Consistency |
| 11 | Depth governance | Implement + test | Architecture doc requirement |
| 12 | Promote lifecycle | Integration test | E2E coverage |
| 13 | Eager loading | Lazy loading with cache | User preference for scalability |
| 14 | Batch loading | Promise.all | Trivial, handles network stores |
| 15 | Sequential tests | Fail-fast | Avoids wasted sandbox time |
| 16 | InMemoryStore scan | Do nothing | Test utility, bounded scale |
