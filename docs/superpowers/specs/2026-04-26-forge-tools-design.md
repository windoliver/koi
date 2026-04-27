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
| `BrickArtifact` (from `@koi/core`) | L0 | **The persisted record.** Discriminated on `kind` (`tool`/`middleware`/`channel`/`skill`/`agent`/`composite`). `lifecycle: BrickLifecycle = "draft" \| "verifying" \| "active" \| "failed" \| "deprecated" \| "quarantined"`. This is what `ForgeStore.save/load/search/update` operates on. |
| `ForgeCandidate` (from `@koi/forge-types`) | L0u | **The in-flight pipeline state.** Demand → Candidate → (verified) → Artifact. Carries proposal metadata between stages. Out of scope here — only emitted by future verifier. |
| `ForgeArtifact` (from `@koi/forge-types`) | L0u | **A post-verification event-shape view** wrapping a `BrickArtifact` with a `ForgeVerificationSummary`, narrowed to terminal published lifecycle. Emitted on `forge_completed` events. **Not** what the store holds. |

Forge tools in this PR produce **`BrickArtifact`s** (kind `tool` or `middleware`) with **`lifecycle: "draft"`** (the L0-defined initial state per `VALID_LIFECYCLE_TRANSITIONS`), save them via `ForgeStore.save()`, and return the new `BrickId`. Promotion through `verifying → active` and emission of `ForgeArtifact`/`ForgeEvent` records is the verifier's job — out of scope for primordial.

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

All four are factory functions returning a `Tool` matching the L0 `Tool` contract. Each takes `{ store: ForgeStore }` via constructor injection. **Caller identity is resolved inside `execute()`**, not at construction — `ToolExecutionContext` is only available during execution via the engine's AsyncLocalStorage (`packages/kernel/engine/src/koi.ts` exposes `getCurrentToolExecutionContext()`). The tool reads `ctx.session.agentId` and any `forge.allowGlobal` capability flag at the start of every invocation. Baking auth state into the tool instance at provider `attach()` time would either be stale (no session yet) or unsafe (one tool reused across sessions).

See *Trust + scope enforcement* below for the visibility predicate.

### `forge_tool`

Synthesize a `ToolArtifact` (`BrickArtifact` with `kind: "tool"`).

| Field | Type | Notes |
|-------|------|-------|
| `name` | `string` | Brick name, kebab-case |
| `description` | `string` | Required |
| `scope` | `"agent" \| "zone" \| "global"` | `ForgeScope` |
| `inputSchema` | `JsonObject` | JSON Schema for tool args |
| `implementation` | `string` | Tool implementation source |

Output: `Result<{ brickId: BrickId; lifecycle: "draft" }, KoiError>`. Builds a `ToolArtifact` with content-addressed `BrickId` via `@koi/hash`, `lifecycle: "draft"`, `provenance` carrying agent origin, and persists via `ForgeStore.save()`.

### `forge_middleware`

Same shape as `forge_tool` but produces an `ImplementationArtifact` with `kind: "middleware"`. Drops `inputSchema`. (Channel synthesis is a sibling case but deferred — issue scope says middleware only.)

### `forge_list`

Query the store and return matching bricks.

| Field | Type | Notes |
|-------|------|-------|
| `kind` *(optional)* | `BrickKind` | tool/middleware/skill/etc. |
| `scope` *(optional)* | `ForgeScope` | agent/zone/global |
| `lifecycle` *(optional)* | `BrickLifecycle` | one of `draft\|verifying\|active\|failed\|deprecated\|quarantined` |
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

`BrickId = sha256(canonical(<identity-fields>))`. Identity fields are the *content* of the brick **plus an owner-tenancy partition** so byte-identical content from different agents/scopes does not collide:

- `kind`, `name`, `description`, `version`, plus kind-discriminated content: `implementation` + `inputSchema` + `outputSchema` (tool/middleware/channel), `content` (skill), `manifestYaml` (agent), `steps` + `exposedInput` + `exposedOutput` (composite).
- `scope` (`agent`/`zone`/`global`).
- `ownerAgentId` for `scope: "agent"` and `scope: "zone"`. For `scope: "global"`, owner is omitted from the hash so global content deduplicates by content alone (anyone synthesizing the same global utility lands on the same id).

This eliminates cross-owner aliasing: if Agent A saves an `agent`-scoped tool, and Agent B synthesizes byte-identical content, the hash differs (A's `ownerAgentId` ≠ B's), so B gets a separate `brickId` it actually owns and can later inspect. Idempotent retries (same agent, same content, same scope) collapse correctly.

Hash excludes all mutable runtime metadata: `lifecycle`, `policy`, `usageCount`, `tags`, `lastVerifiedAt`, `fitness`, `trailStrength`, `driftContext`, `collectiveMemory`, `trigger`, `namespace`, `trustTier`, `storeVersion`, `signature`, plus the timestamp/invocationId fields of `provenance` (only `provenance.metadata.agentId` flows in via `ownerAgentId`).

`scope` is in the hash but is also a field on L0's `BrickUpdate`. To prevent identity drift, the in-memory store **rejects scope changes at update time** (returns `KoiError "INVARIANT_VIOLATION"` with code-context "scope is identity-bearing in @koi/forge-tools; use a fresh save"). This is a stricter local invariant than the general L0 `BrickUpdate` contract — `forge-tools` callers must re-synthesize to change scope. Documented in `docs/L2/forge-tools.md`.

A compile-time guard in `shared.ts` checks the disjointness of hashed-vs-mutable fields:

```ts
type _AssertHashFieldsDisjointFromMutable =
  Exclude<keyof BrickUpdate, "expectedVersion" | "scope"> & HashedFieldNames extends never
    ? true : never;
```

(`scope` is the one declared exception, handled by the runtime rejection above.)

### Behavior

- `save(brick)`: recompute `BrickId` from identity fields via `@koi/hash`. If recomputed id mismatches `brick.id` → `KoiError "INVARIANT_VIOLATION"`. If id already present → check **identity-field equality only** (kind/name/description/version/kind-discriminated content) against the stored record. Identity match → return success without overwriting (idempotent retry; original `provenance`, `lifecycle`, `usageCount`, etc. are preserved — first save wins for metadata). Identity mismatch on the same id → `KoiError "INVARIANT_VIOLATION"` (sha256 collision or tampering). Otherwise insert with `storeVersion: 1` and notify (`StoreChangeEvent { kind: "saved" }`).
- `load(id)`: returns artifact or `KoiError "NOT_FOUND"`.
- `search(query)`: filter via `matchesBrickQuery`, sort via `sortBricks`, slice by `query.limit`. **Caller scope is enforced here** — see Trust + scope below.
- `update(id, updates)`: optimistic locking via `expectedVersion`. Mismatch → `CONFLICT`. Apply via `applyBrickUpdate`, increment `storeVersion`, notify (`updated`). Empty update is a no-op success. (`BrickUpdate` only contains non-hashed fields by L0 contract.)
- `remove(id)`: deletes; notifies (`removed`). Missing → `NOT_FOUND`.
- `watch(listener)`: backed by `createMemoryStoreChangeNotifier`. Returns unsubscribe.
- `dispose()`: clears notifier subscriptions.

No eviction, no persistence across restarts. Pure `Map<BrickId, BrickArtifact>`.

### Trust + scope enforcement (visibility model)

`forge_list` and `forge_inspect` return artifacts that an agent can *see*. Without a visibility check, any agent calling these tools could enumerate every artifact in a shared store, including implementation source from other agents.

**Forge tools fail closed: `scope: "zone"` is rejected at the agent-facing surface in this PR.** The L0 `ForgeScope` enum keeps `zone` first-class, and `inherited-component-provider` continues to read zone-scoped artifacts directly from the store (engine-internal path, not via these tools). But until core carries a real `zoneId`, the `forge_*` LLM-facing tools cannot enforce zone isolation, so they refuse to write or expose zone artifacts:

- `forge_tool` / `forge_middleware` with `scope: "zone"` → `KoiError "INVALID_INPUT"` (message: "zone scope unsupported in primordial forge-tools — pending zoneId in core").
- `forge_list` filter `scope: "zone"` → returns empty array; unfiltered list omits zone-scoped artifacts entirely.
- `forge_inspect` of a zone-scoped artifact → `KoiError "NOT_FOUND"`.

This narrows the surface to `agent` (private to originator) and `global` (universal) — both have enforceable predicates. Once `zoneId` lands, zone moves to first-class with its own visibility rule.

Visibility predicate inside `execute()` (caller resolved live from `getCurrentToolExecutionContext()`):

| Artifact scope | Visibility via forge tools |
|---|---|
| `agent` | `artifact.provenance.metadata.agentId === ctx.session.agentId` |
| `zone` | hidden (pending zoneId) |
| `global` | always |

`forge_list`: tool calls `store.search(query)` then applies the visibility predicate to each hit before returning summaries. Out-of-scope hits dropped silently.
`forge_inspect`: tool calls `store.load(brickId)`, then applies the visibility predicate to the returned artifact. Predicate failure → `KoiError "NOT_FOUND"` (same code as a missing id; existence non-leak). The store's `load()` is unconditional by design (it is an L0 contract and other trusted runtime paths — e.g. `inherited-component-provider` — depend on unconditional reads); enforcement lives in the LLM-facing tool wrapper. The tool **must not return** the raw `BrickArtifact` without running the predicate.

**Synthesis authorization** (also resolved live in `execute()`):

- `scope: "agent"` synthesis: any caller; `provenance.metadata.agentId` is filled in by the tool from `ctx.session.agentId`, not by the caller.
- `scope: "zone"` synthesis: rejected (see above).
- `scope: "global"` synthesis: requires the caller's `ToolExecutionContext` to carry a `forge.allowGlobal: true` capability. Without it → `KoiError "FORBIDDEN"`.

### Trust boundary

The in-memory `ForgeStore` exposes unrestricted `save`, `load`, `search`, `update`, `remove` — it is the **L0 contract**, not an LLM-facing surface, and other trusted runtime code (engine `inherited-component-provider`, future `ForgePipeline` verifier, `mcp-server` tool-cache) needs unconditional access. The store is never injected into LLM-controlled tool implementations.

**Authorization lives exclusively at the LLM-facing tool wrapper boundary** (`forge_tool`/`forge_middleware`/`forge_list`/`forge_inspect`). Each tool's `execute()`:

1. Resolves caller identity from `getCurrentToolExecutionContext()`.
2. Applies scope/visibility/capability predicates.
3. Calls store mutators with arguments derived from the validated input — caller cannot bypass.

Wiring contract: `@koi/runtime` and any other meta-package that exposes forge tools to a model **must** wrap the store with these tool factories and never expose the raw store via `agent.query("tool:")` or any other LLM-reachable surface. A `docs/L2/forge-tools.md` "Wiring" section makes this requirement explicit.

A follow-up issue tracks adding a real `zoneId` to `ForgeScope` / `ForgeRunMetadata` / `SessionContext` so zone visibility can be promoted from "rejected" to first-class.

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
2. **forge_tool**: valid input → `ToolArtifact` persisted with `kind: "tool"`, `lifecycle: "draft"`, `id` matches recomputed content hash including `ownerAgentId` (or content-only for global); invalid input → `INVALID_INPUT`; `scope: "zone"` → `INVALID_INPUT`; descriptor satisfies `ToolDescriptor`; double-synthesize same content same agent (retry, possibly different provenance timestamp/invocationId) → idempotent success returning the same `brickId`, original metadata preserved; **two different agents synthesizing byte-identical agent-scoped content produce two different `brickId`s, each visible only to its owner** (cross-tenant aliasing test); caller without `allowGlobal` requesting `scope: "global"` → `FORBIDDEN`; caller resolved from `getCurrentToolExecutionContext()` not from constructor injection (tool built outside any session, succeeds only inside `runWithToolExecutionContext`).
3. **forge_middleware**: same as forge_tool but for `ImplementationArtifact` with `kind: "middleware"`.
4. **forge_list**: filter by kind/scope/lifecycle; empty store → empty array; respects `limit` and hard cap (200); visibility — agent-scope brick from another agent omitted silently; zone-scope brick omitted entirely (forge-tool tools reject zone reads pending zoneId); global-scope brick visible to all; explicit `scope: "zone"` filter → empty array.
5. **forge_inspect**: returns artifact for known visible id; returns `NOT_FOUND` for unknown id; returns `NOT_FOUND` (not `FORBIDDEN`) for a known agent-scoped id owned by a different agent (existence non-leak); returns `NOT_FOUND` for any zone-scoped id (zone hidden in this PR); test exercises the by-id path explicitly to confirm the tool wrapper applies the predicate after `store.load()` rather than relying on `search` filtering.

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
- Real `zoneId` field on `ForgeArtifact` / `ForgeRunMetadata` / `SessionContext` so zone isolation can be enforced first-class instead of inheritance-shaped (today zone artifacts are visible to all callers, matching `inherited-component-provider`).
- ForgePipeline + verifier emit `ForgeArtifact`/`ForgeEvent` once verified; only then do we observe lifecycle promotion `draft → verifying → active`.

## v1 references

- `archive/v1/packages/forge/forge-tools/src/memory-store.ts` — port simplified
- `archive/v1/packages/forge/forge-tools/src/tools/forge-tool.ts` — port shape; drop trust/skill plumbing
- `archive/v1/packages/forge/forge-tools/src/tools/forge-impl.ts` — port middleware half only
- `archive/v1/packages/forge/forge-tools/src/tools/search-forge.ts` — port query path into `forge-list.ts`; full inspect into `forge-inspect.ts`

## Claude Code source reference

Tool descriptor + Zod input schema pattern matches `claude-code-source-code/src/utils/skills/` skill-tool wiring (each skill registers a `tool.descriptor` carrying a JSON Schema derived from a Zod definition). No direct code copy.
