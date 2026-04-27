# `@koi/forge-tools` — Primordial Forge Tools (v2 Phase 3-forge-2)

**Issue:** #1344
**Branch:** `feat/forge-tools-1344`
**Layer:** L2
**Path:** `packages/lib/forge-tools/`
**Target LOC:** ~400

## Goal

Provide the first concrete implementation of `@koi/core`'s `ForgeStore` contract plus four primordial forge tools (`forge_tool`, `forge_middleware`, `forge_list`, `forge_inspect`) so an agent can synthesize, list, and inspect `BrickArtifact`s at runtime. This is a v1-aligned subset — the full v1 `forge-tools` (8.4K LOC, 13 tools) is out of scope; we port only what an agent loop needs to demonstrate the synthesize → list → inspect cycle.

## Non-goals

- ForgePipeline (verify, attest, governance gate) — issue 3-forge-3+.
- Component provider, resolver, registry sync, brick→tool mapping.
- Skill synthesis, edit, agent, compose, promote, delegate tools.
- Persistence beyond in-memory.

## Dependencies

| Package | Source | Why |
|---------|--------|-----|
| `@koi/core` | L0 | `ForgeStore`, `BrickArtifact`, `Tool`, `KoiError`, `Result` |
| `@koi/forge-types` | L0u (#1343) | `ForgeArtifact`, `ForgeCandidate`, `ForgeToolInput`, `ForgeToolResult`, lifecycle types |
| `@koi/validation` | L0u | `applyBrickUpdate`, `sortBricks`, `matchesBrickQuery`, `createMemoryStoreChangeNotifier` |
| `@koi/hash` | L0u | Content-hash → `BrickId` |
| `zod` | external (4.3.6, exact) | Tool input schemas + JSON Schema export (matches v2 convention used by `spawn-tools`, `skill-tool`) |

No dep on `@koi/engine`, no dep on peer L2 packages.

## Tool surface

All four are factory functions returning a `Tool` matching the L0 `Tool` contract. Each takes `{ store: ForgeStore }` via constructor injection.

### `forge_tool`

Synthesize a Tool `BrickArtifact` from spec.

| Field | Type | Notes |
|-------|------|-------|
| `name` | `string` | Brick name, kebab-case |
| `description` | `string` | Required; no leaking PII |
| `scope` | `"agent" \| "zone" \| "global"` | `ForgeScope` |
| `inputSchema` | `JsonObject` | JSON Schema for tool args |
| `code` | `string` | Tool implementation source (TypeScript) |
| `signal` *(optional)* | `ForgeDemandSignal` | Originating demand, if any |

Output: `ForgeToolResult` discriminated union (`{ ok: true, artifactId, lifecycle: "synthesizing" } | { ok: false, error }`). Persists artifact to store with `lifecycle: "synthesizing"` and stub `ForgeVerificationSummary`.

### `forge_middleware`

Same shape as `forge_tool` but for middleware bricks. Adds `hooks: readonly MiddlewareHook[]`. Produces a Middleware `BrickArtifact`.

### `forge_list`

Query the store and return summaries.

| Field | Type | Notes |
|-------|------|-------|
| `kind` *(optional)* | `BrickKind` | Filter by tool/middleware/skill/etc. |
| `scope` *(optional)* | `ForgeScope` | Filter by agent/zone/global |
| `lifecycle` *(optional)* | `ForgeLifecycleState` | Filter by lifecycle state |

Output: `{ candidates: readonly ForgeCandidate[] }`. Uses `matchesBrickQuery` from `@koi/validation`. Sorted via `sortBricks`.

### `forge_inspect`

Fetch one full `ForgeArtifact` by id.

| Field | Type | Notes |
|-------|------|-------|
| `brickId` | `BrickId` | Branded id |

Output: `{ artifact: ForgeArtifact | null }`. Returns `null` (not error) when missing — caller decides if absence is an error.

## In-memory store

Port of v1's `createInMemoryForgeStore`. Implements the L0 `ForgeStore` interface fully:

- `get(id)` / `list(query)` / `put(artifact)` / `update(id, update, expectedVersion)` / `delete(id)` / `watch(handler)`
- Content-integrity check on `put` (recomputed `BrickId` via `@koi/hash`; mismatch → `KoiError "INVARIANT_VIOLATION"`).
- Optimistic locking on `update` via `expectedVersion` (mismatch → `KoiError "CONFLICT"`).
- `watch()` backed by `createMemoryStoreChangeNotifier` from `@koi/validation`.
- No eviction, no persistence across restarts. Pure `Map<BrickId, ForgeArtifact>`.

## File layout

```
packages/lib/forge-tools/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/
    ├── index.ts                       (~30 LOC, named re-exports — no barrel-at-scale)
    ├── memory-store.ts                (~150 LOC)
    ├── memory-store.test.ts           (~80 LOC)
    ├── tools/
    │   ├── shared.ts                  (~50 LOC, content-hash → BrickId, artifact builders)
    │   ├── forge-tool.ts              (~50 LOC)
    │   ├── forge-tool.test.ts         (~40 LOC)
    │   ├── forge-middleware.ts        (~50 LOC)
    │   ├── forge-middleware.test.ts   (~35 LOC)
    │   ├── forge-list.ts              (~30 LOC)
    │   ├── forge-list.test.ts         (~30 LOC)
    │   ├── forge-inspect.ts           (~25 LOC)
    │   └── forge-inspect.test.ts      (~25 LOC)
docs/L2/forge-tools.md                 (doc-gate)
```

Total: ~395 LOC source + ~210 LOC tests.

## Errors

- Expected failures → `Result<T, KoiError>` (e.g. `"NOT_FOUND"`, `"CONFLICT"`, `"INVALID_INPUT"`).
- Zod validation failures → `KoiError "INVALID_INPUT"` with `context.issues` carrying the Zod issue list.
- Unexpected → throw with `cause` chaining (only for invariants that prove a bug, never for caller mistakes).

## Tests

Unit (colocated `*.test.ts`):

1. **memory-store**: round-trip put/get/list/delete; content-integrity rejection on tampered artifact; version conflict on stale update; watcher fires on put/update/delete.
2. **forge_tool / forge_middleware**: valid input → artifact persisted with `lifecycle: "synthesizing"`; invalid input rejected with `INVALID_INPUT`; descriptor returned by `tool.descriptor` satisfies `ToolDescriptor`.
3. **forge_list**: filter by kind/scope/lifecycle; empty store returns empty array; sorted by created-at desc.
4. **forge_inspect**: returns artifact for known id; returns `null` for unknown id.

No integration tests in this PR — golden-query coverage handles end-to-end.

## Wiring (`@koi/runtime` golden-query rule)

Per CLAUDE.md, every new L2 PR must be wired into `@koi/runtime` with a golden query:

1. Add `@koi/forge-tools` as `@koi/runtime` dependency.
2. New `QueryConfig` entry in `packages/meta/runtime/scripts/record-cassettes.ts` named `forge-synthesize`. Prompt: *"create a tool that adds two numbers, then list available bricks, then inspect the new tool"*.
3. Record cassette + trajectory with real LLM.
4. Add trajectory assertions to `golden-replay.test.ts`: forge_tool tool step present, ForgeStore.put event, forge_list returns ≥1 candidate, forge_inspect returns the just-synthesized artifact.
5. Add 2 standalone golden queries (no LLM): synthesize-then-inspect; list-empty-store.

## Open invariants verified by CI

- [ ] `bun run check:layers` — L2 deps only `@koi/core` + L0u
- [ ] `bun run check:orphans` — `@koi/forge-tools` is dep of `@koi/runtime`
- [ ] `bun run check:golden-queries` — `forge_tool` has trajectory assertions
- [ ] `bun run typecheck` — TS6 strict, isolatedDeclarations, exactOptionalPropertyTypes
- [ ] `bun run test --filter=@koi/forge-tools` — ≥80% line/function/statement coverage
- [ ] `bun run test --filter=@koi/runtime` — full-loop replay passes

## v1 references

- `archive/v1/packages/forge/forge-tools/src/memory-store.ts` — port simplified
- `archive/v1/packages/forge/forge-tools/src/tools/forge-tool.ts` — port shape, drop trust/skill plumbing
- `archive/v1/packages/forge/forge-tools/src/tools/forge-impl.ts` — split into `forge-middleware.ts` (drop channel half — out of scope)
- `archive/v1/packages/forge/forge-tools/src/tools/search-forge.ts` — port query path only into `forge-list.ts`; full inspect logic into `forge-inspect.ts`

## Claude Code source reference

Tool descriptor + Zod input schema pattern matches `claude-code-source-code/src/utils/skills/` skill-tool wiring (where each skill registers a `tool.descriptor` carrying a JSON Schema derived from a Zod definition). No direct code copy.
