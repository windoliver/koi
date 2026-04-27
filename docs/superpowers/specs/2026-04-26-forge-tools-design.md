# `@koi/forge-tools` — Primordial Forge Tools (v2 Phase 3-forge-2)

**Issue:** #1344
**Branch:** `feat/forge-tools-1344`
**Layer:** L2
**Path:** `packages/lib/forge-tools/`
**Target LOC:** ~400

## Goal

Provide the first concrete implementation of `@koi/core`'s `ForgeStore` contract plus four primordial forge tools (`forge_tool`, `forge_middleware`, `forge_list`, `forge_inspect`) so an agent can synthesize, list, and inspect `BrickArtifact`s at runtime. This is a v1-aligned subset — the full v1 `forge-tools` (8.4K LOC, 13 tools) is out of scope; we port only what an agent loop needs to demonstrate the synthesize → list → inspect cycle.

## Type model — what is persisted vs what is reported

| Type | Source | Role |
|------|--------|------|
| `BrickArtifact` (from `@koi/core`) | L0 | **The persisted record.** Discriminated on `kind` (`tool`/`middleware`/`channel`/`skill`/`agent`/`composite`). `lifecycle: BrickLifecycle` covers the full enum including `synthesizing`/`verifying`/`published`/`retired`. This is what `ForgeStore.save/load/search/update` operates on. |
| `ForgeCandidate` (from `@koi/forge-types`) | L0u | **The in-flight pipeline state.** Demand → Candidate → (verified) → Artifact. Carries proposal metadata between stages. Out of scope here — only emitted by future verifier. |
| `ForgeArtifact` (from `@koi/forge-types`) | L0u | **A post-publication event-shape view** wrapping a `BrickArtifact` with a `ForgeVerificationSummary` and a narrow `lifecycle: "published" \| "retired"`. Emitted on `forge_completed` events. **Not** what the store holds. |

Forge tools in this PR produce **`BrickArtifact`s** (kind `tool` or `middleware`/`channel`) with `lifecycle: "synthesizing"`, save them via `ForgeStore.save()`, and return the new `BrickId`. Promotion to `published` and emission of `ForgeArtifact`/`ForgeEvent` records is the verifier's job — out of scope for primordial.

## Non-goals

- ForgePipeline (verify, attest, governance gate) — issue 3-forge-3+.
- Component provider, resolver, registry sync, brick→tool mapping.
- Skill synthesis, edit, agent, compose, promote, delegate tools.
- Persistence beyond in-memory.
- Emitting `ForgeArtifact`/`ForgeEvent` records (those need verification first).

## Dependencies

| Package | Source | Why |
|---------|--------|-----|
| `@koi/core` | L0 | `ForgeStore`, `BrickArtifact`, `BrickLifecycle`, `ToolArtifact`, `ImplementationArtifact`, `ForgeQuery`, `BrickUpdate`, `Tool`, `KoiError`, `Result` |
| `@koi/forge-types` | L0u (#1343) | Lifecycle helpers + `ForgeToolInput`/`ForgeToolResult` shape |
| `@koi/validation` | L0u | `applyBrickUpdate`, `sortBricks`, `matchesBrickQuery`, `createMemoryStoreChangeNotifier` |
| `@koi/hash` | L0u | Content-hash → `BrickId` |
| `zod` | external (4.3.6, exact) | Tool input schemas + JSON Schema export (matches v2 convention used by `spawn-tools`, `skill-tool`) |

No dep on `@koi/engine`, no dep on peer L2 packages.

## Tool surface

All four are factory functions returning a `Tool` matching the L0 `Tool` contract. Each takes `{ store: ForgeStore; caller: CallerContext }` via constructor injection, where `CallerContext = { agentId: string; zoneId: string | null }` resolved from the agent loop's `ExecutionContext` at tool-build time. Caller context drives the visibility model described under *Trust + scope enforcement*.

### `forge_tool`

Synthesize a `ToolArtifact` (`BrickArtifact` with `kind: "tool"`).

| Field | Type | Notes |
|-------|------|-------|
| `name` | `string` | Brick name, kebab-case |
| `description` | `string` | Required |
| `scope` | `"agent" \| "zone" \| "global"` | `ForgeScope` |
| `inputSchema` | `JsonObject` | JSON Schema for tool args |
| `implementation` | `string` | Tool implementation source |

Output: `Result<{ brickId: BrickId; lifecycle: "synthesizing" }, KoiError>`. Builds a `ToolArtifact` with content-addressed `BrickId` via `@koi/hash`, `lifecycle: "synthesizing"`, `provenance` carrying agent origin, and persists via `ForgeStore.save()`.

### `forge_middleware`

Same shape as `forge_tool` but produces an `ImplementationArtifact` with `kind: "middleware"`. Drops `inputSchema`. (Channel synthesis is a sibling case but deferred — issue scope says middleware only.)

### `forge_list`

Query the store and return matching bricks.

| Field | Type | Notes |
|-------|------|-------|
| `kind` *(optional)* | `BrickKind` | tool/middleware/skill/etc. |
| `scope` *(optional)* | `ForgeScope` | agent/zone/global |
| `lifecycle` *(optional)* | `BrickLifecycle` | filter by lifecycle |
| `limit` *(optional)* | `number` | default 50, hard cap 200 |

Output: `Result<{ summaries: readonly BrickSummary[] }, KoiError>`. Uses `ForgeStore.search()` (or `searchSummariesWithFallback()` from `@koi/core` to get summary projection cheaply). Returns `BrickSummary` (~20 tokens/brick) — full artifacts via `forge_inspect`.

### `forge_inspect`

Fetch one full `BrickArtifact` by id.

| Field | Type | Notes |
|-------|------|-------|
| `brickId` | `BrickId` | branded id |

Output: `Result<{ artifact: BrickArtifact }, KoiError>`. Returns `KoiError "NOT_FOUND"` when missing.

## In-memory store

Concrete implementation of L0's `ForgeStore` interface. Ports v1's `createInMemoryForgeStore` simplified.

Implements: `save`, `load`, `search`, `searchSummaries`, `remove`, `update`, `exists`, `watch`, `dispose`. Skips optional `promote` / `promoteAndUpdate` / `lineage` (out of primordial scope).

### Content-addressed identity vs mutable metadata

`BrickId = sha256(canonical(<identity-fields>))`. Identity fields are the *content* of the brick — fields that, if changed, mean it is a different brick:

- `kind`, `name`, `description`, `scope`, `provenance`, `version`, plus kind-discriminated content: `implementation` + `inputSchema` + `outputSchema` (tool/middleware/channel), `content` (skill), `manifestYaml` (agent), `steps` + `exposedInput` + `exposedOutput` (composite).

Hash excludes mutable runtime metadata: `lifecycle`, `policy`, `usageCount`, `tags`, `lastVerifiedAt`, `fitness`, `trailStrength`, `driftContext`, `collectiveMemory`, `trigger`, `namespace`, `trustTier`, `storeVersion`, `signature`. These overlap exactly with the L0 `BrickUpdate` field set — `update()` is therefore by-construction restricted to non-identity fields and `BrickId` cannot drift from content. A `_AssertHashFieldsDisjointFromUpdate` compile-time check in `shared.ts` enforces this:

```ts
type _AssertNoHashedFieldInUpdate =
  Exclude<keyof BrickUpdate, "expectedVersion"> & HashedFieldNames extends never
    ? true : never;
```

If a future PR adds a hashed field to `BrickUpdate` (or vice versa) the build breaks before behavior diverges.

### Behavior

- `save(brick)`: recompute `BrickId` from identity fields via `@koi/hash`. If recomputed id mismatches `brick.id` → `KoiError "INVARIANT_VIOLATION"`. If id already present **and stored content is structurally identical** → return success (idempotent — handles retry-after-timeout). If id already present **but content differs** → `KoiError "INVARIANT_VIOLATION"` (this is a sha256 collision or tampering, not a real conflict). Otherwise insert with `storeVersion: 1` and notify (`StoreChangeEvent { kind: "saved" }`).
- `load(id)`: returns artifact or `KoiError "NOT_FOUND"`.
- `search(query)`: filter via `matchesBrickQuery`, sort via `sortBricks`, slice by `query.limit`. **Caller scope is enforced here** — see Trust + scope below.
- `update(id, updates)`: optimistic locking via `expectedVersion`. Mismatch → `CONFLICT`. Apply via `applyBrickUpdate`, increment `storeVersion`, notify (`updated`). Empty update is a no-op success. (`BrickUpdate` only contains non-hashed fields by L0 contract.)
- `remove(id)`: deletes; notifies (`removed`). Missing → `NOT_FOUND`.
- `watch(listener)`: backed by `createMemoryStoreChangeNotifier`. Returns unsubscribe.
- `dispose()`: clears notifier subscriptions.

No eviction, no persistence across restarts. Pure `Map<BrickId, BrickArtifact>`.

### Trust + scope enforcement (visibility model)

`forge_list` and `forge_inspect` return artifacts that an agent can *see*. Without a visibility check, any agent calling these tools could enumerate every artifact in a shared store, including implementation source from other agents/zones.

Each `create*Tool` factory takes a required `caller: { agentId: string; zoneId: string | null }` resolved from the agent loop's `ExecutionContext` at tool-build time. The store applies a visibility predicate:

- `scope: "agent"` artifact → visible only when `provenance.metadata.agentId === caller.agentId`.
- `scope: "zone"` artifact → visible only when `caller.zoneId === artifact.scope.zoneId` (or both null).
- `scope: "global"` artifact → visible to everyone.

`forge_list`: scope filter intersected with visibility predicate; out-of-scope hits are dropped silently (do not leak existence).
`forge_inspect`: visibility predicate evaluated; failure → `KoiError "NOT_FOUND"` (do not leak existence with `FORBIDDEN`).
`forge_tool` / `forge_middleware`: caller scope must be ≥ requested artifact scope (agent < zone < global). Privilege-escalation attempt → `KoiError "FORBIDDEN"`.

Same predicate used for `search` and `searchSummaries` projections — store applies it once, tools never re-implement.

## File layout

```
packages/lib/forge-tools/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/
    ├── index.ts                       (~30 LOC, named re-exports — no barrel-at-scale)
    ├── memory-store.ts                (~150 LOC)
    ├── memory-store.test.ts           (~90 LOC)
    ├── tools/
    │   ├── shared.ts                  (~60 LOC, content-hash → BrickId, BrickArtifact builders, KoiError factories)
    │   ├── forge-tool.ts              (~55 LOC)
    │   ├── forge-tool.test.ts         (~45 LOC)
    │   ├── forge-middleware.ts        (~50 LOC)
    │   ├── forge-middleware.test.ts   (~35 LOC)
    │   ├── forge-list.ts              (~30 LOC)
    │   ├── forge-list.test.ts         (~30 LOC)
    │   ├── forge-inspect.ts           (~25 LOC)
    │   └── forge-inspect.test.ts      (~25 LOC)
docs/L2/forge-tools.md                 (doc-gate)
```

Total: ~400 LOC source + ~225 LOC tests.

## Errors

- Expected failures → `Result<T, KoiError>` (`NOT_FOUND`, `CONFLICT`, `INVALID_INPUT`, `INVARIANT_VIOLATION`).
- Zod validation failures → `KoiError "INVALID_INPUT"` with `context.issues` carrying the Zod issue list.
- Unexpected → throw with `cause` (only for invariants that prove a bug, never caller mistakes).
- Error messages do not leak internal paths or stack traces.

## Tests

Unit (colocated `*.test.ts`):

1. **memory-store**: round-trip save/load/search/remove; content-integrity rejection on tampered artifact (mutated content with stale id); version conflict on stale `expectedVersion`; watcher fires on save/update/remove with correct `kind`; empty-update no-op; `searchSummaries` projection equivalent to `search` + map.
2. **forge_tool**: valid input → `ToolArtifact` persisted with `kind: "tool"`, `lifecycle: "synthesizing"`, `id` matches recomputed content hash; invalid input → `INVALID_INPUT`; descriptor returned by `tool.descriptor` satisfies `ToolDescriptor`; double-synthesize same content (retry case) → idempotent success returning the same `brickId`; cross-scope synthesize (agent caller requesting `scope: "global"`) → `FORBIDDEN`.
3. **forge_middleware**: same as forge_tool but for `ImplementationArtifact` with `kind: "middleware"`.
4. **forge_list**: filter by kind/scope/lifecycle; empty store → empty array; respects `limit` and hard cap (200); visibility — agent-scope brick from another agent is omitted silently; zone-scope brick from another zone is omitted silently; global-scope brick visible to all.
5. **forge_inspect**: returns artifact for known visible id; returns `NOT_FOUND` for unknown id; returns `NOT_FOUND` (not `FORBIDDEN`) for known-but-not-visible id (existence non-leak).

≥80% line/function/statement coverage (CI threshold).

## Wiring (`@koi/runtime` golden-query rule)

Per CLAUDE.md, every new L2 PR must be wired into `@koi/runtime` with golden-query coverage:

1. Add `@koi/forge-tools` as `@koi/runtime` dependency.
2. New `QueryConfig` in `packages/meta/runtime/scripts/record-cassettes.ts` named `forge-synthesize`. Prompt: *"create a tool that adds two numbers, then list available bricks, then inspect the new tool"*.
3. Record cassette + trajectory with real LLM.
4. Trajectory assertions in `golden-replay.test.ts`: `forge_tool` tool step, ForgeStore `saved` event, `forge_list` returns ≥1 summary, `forge_inspect` returns the just-synthesized artifact.
5. 2 standalone golden queries (no LLM): synthesize-then-inspect; list-empty-store.

## Open invariants verified by CI

- [ ] `bun run check:layers` — L2 deps only `@koi/core` + L0u
- [ ] `bun run check:orphans` — `@koi/forge-tools` is dep of `@koi/runtime`
- [ ] `bun run check:golden-queries` — `forge_tool` has trajectory assertions
- [ ] `bun run typecheck` — TS6 strict, isolatedDeclarations, exactOptionalPropertyTypes
- [ ] `bun run test --filter=@koi/forge-tools` — ≥80% line/function/statement coverage
- [ ] `bun run test --filter=@koi/runtime` — full-loop replay passes

## Out-of-scope follow-ups (not this PR)

- `isForgeEvent` in `@koi/forge-types` accepts shallow nested payloads (raised by review against #2061). File a follow-up issue to either tighten nested validation or rename to a documented envelope-only check. Tracked separately.
- ForgePipeline + verifier emit `ForgeArtifact`/`ForgeEvent` once verified; only then do we observe lifecycle promotion `synthesizing → verifying → published`.

## v1 references

- `archive/v1/packages/forge/forge-tools/src/memory-store.ts` — port simplified
- `archive/v1/packages/forge/forge-tools/src/tools/forge-tool.ts` — port shape; drop trust/skill plumbing
- `archive/v1/packages/forge/forge-tools/src/tools/forge-impl.ts` — port middleware half only
- `archive/v1/packages/forge/forge-tools/src/tools/search-forge.ts` — port query path into `forge-list.ts`; full inspect into `forge-inspect.ts`

## Claude Code source reference

Tool descriptor + Zod input schema pattern matches `claude-code-source-code/src/utils/skills/` skill-tool wiring (each skill registers a `tool.descriptor` carrying a JSON Schema derived from a Zod definition). No direct code copy.
