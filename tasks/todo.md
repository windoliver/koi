# Issue #455: L0 MemoryTier type + extend MemoryResult/MemoryRecallOptions

## Decisions Log

| # | Area | Decision | Choice |
|---|------|----------|--------|
| A1 | Architecture | MemoryTier type shape | **A1-A**: Fixed union `"hot" \| "warm" \| "cold"` |
| C1 | Code Quality | decayScore constraint | **C1-A**: Plain `number` + JSDoc `[0.0, 1.0]` |
| T1 | Tests | Test scope | **T1-B**: Moderate — export guard + structural type tests |
| P1 | Performance | lastAccessed type | **P1-A**: `string` ISO-8601 |

---

## Phase 1: Add types to `packages/core/src/ecs.ts` (~20 LOC)

### 1.1 New MemoryTier type (insert before MemoryResult, after singleton comment)
```typescript
/** Memory temperature tier for decay-based prioritization. */
export type MemoryTier = "hot" | "warm" | "cold";
```
- [ ] Add MemoryTier type

### 1.2 Extend MemoryResult with 3 optional fields
```typescript
/** Temperature tier — backends that support tiering populate this. */
readonly tier?: MemoryTier | undefined;
/** Current decay factor in [0.0, 1.0] — 1.0 = no decay, 0.0 = fully decayed. */
readonly decayScore?: number | undefined;
/** ISO-8601 timestamp of last access — used by decay engine. */
readonly lastAccessed?: string | undefined;
```
- [ ] Extend MemoryResult

### 1.3 Extend MemoryRecallOptions with 2 optional fields
```typescript
/** Filter results by temperature tier. Omit or "all" to include all tiers. */
readonly tierFilter?: MemoryTier | "all" | undefined;
/** Maximum number of results to return. Backend-specific default if omitted. */
readonly limit?: number | undefined;
```
- [ ] Extend MemoryRecallOptions

### 1.4 Extend MemoryStoreOptions with 2 optional fields
```typescript
/** Semantic category for fact classification (e.g., "milestone", "preference"). */
readonly category?: string | undefined;
/** Entity IDs this memory relates to — enables graph-aware retrieval. */
readonly relatedEntities?: readonly string[] | undefined;
```
- [ ] Extend MemoryStoreOptions

---

## Phase 2: Export from `packages/core/src/index.ts` (~1 LOC)

Add `MemoryTier` to ecs type export block (between MemoryComponent and MemoryRecallOptions):
- [ ] Add MemoryTier to type exports

---

## Phase 3: Update `packages/core/src/__tests__/exports.test.ts` (~5 LOC)

- [ ] Add `MemoryRecallOptions`, `MemoryStoreOptions`, `MemoryTier` to type import
- [ ] Add `AssertDefined<MemoryTier>`, `AssertDefined<MemoryRecallOptions>`, `AssertDefined<MemoryStoreOptions>` to _TypeGuard union

---

## Phase 4: Add structural type tests in `packages/core/src/__tests__/types.test.ts` (~40 LOC)

New `describe("MemoryTier and extended memory types")` block:

- [ ] Test MemoryTier accepts valid tier literals ("hot", "warm", "cold")
- [ ] Test MemoryResult with all new fields (tier, decayScore, lastAccessed) compiles
- [ ] Test MemoryResult without new fields still compiles (backward compat)
- [ ] Test MemoryRecallOptions with tierFilter + limit compiles
- [ ] Test MemoryRecallOptions without new fields still compiles (backward compat)
- [ ] Test MemoryStoreOptions with category + relatedEntities compiles
- [ ] Test MemoryStoreOptions without new fields still compiles (backward compat)
- [ ] Test tierFilter accepts "all" literal alongside MemoryTier values

---

## Phase 5: Verify

- [ ] `bun test --filter core` passes
- [ ] `turbo build --filter @koi/core` succeeds
- [ ] API surface snapshot updated
- [ ] No L0 violations (zero imports from other @koi/* packages)
- [ ] All interface properties are `readonly`
- [ ] ESM-only `.js` extensions in imports

## Anti-Leak Checklist
- [ ] @koi/core has zero import statements from other packages
- [ ] No new function bodies (types only)
- [ ] All new interface properties are `readonly`
- [ ] No vendor types in L0

---

## Files Summary

| File | Action | Est. LOC |
|------|--------|----------|
| `packages/core/src/ecs.ts` | Modify | +20 |
| `packages/core/src/index.ts` | Modify | +1 |
| `packages/core/src/__tests__/exports.test.ts` | Modify | +5 |
| `packages/core/src/__tests__/types.test.ts` | Modify | +40 |

**Total**: ~66 LOC across 4 files
