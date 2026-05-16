# Issue 1400 Community Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the v2 community registry package with HTTP publish, discovery, search, install, version, and trust scoring behavior.

**Architecture:** Add `packages/net/community-registry` as an L2 package. Keep storage behind a backend interface, ship an in-memory backend first, and expose a composable HTTP handler that returns `null` for unmatched routes.

**Tech Stack:** Bun, `bun:test`, TypeScript 6, Zod, `@koi/validation`.

---

### Task 1: Package Skeleton And API

**Files:**
- Create: `packages/net/community-registry/package.json`
- Create: `packages/net/community-registry/tsconfig.json`
- Create: `packages/net/community-registry/tsup.config.ts`
- Create: `packages/net/community-registry/src/index.ts`
- Create: `packages/net/community-registry/src/types.ts`
- Modify: `scripts/layers.ts`

- [ ] Add package metadata and build/test scripts matching adjacent `packages/net/*` packages.
- [ ] Define `MarketplaceEntry`, `MarketplacePublishRequest`, `CommunityRegistryBackend`, `CommunityRegistryHandler`, and install/discovery response contracts in `types.ts`.
- [ ] Export the public API from `index.ts`.
- [ ] Add `@koi/community-registry` to `L2_PACKAGES`.

### Task 2: Validation And Trust

**Files:**
- Create: `packages/net/community-registry/src/validation.ts`
- Create: `packages/net/community-registry/src/trust.ts`
- Test: `packages/net/community-registry/src/handler.test.ts`

- [ ] Write failing tests for accepting a valid skill publish and rejecting invalid publish payloads.
- [ ] Implement Zod request validation plus local skill frontmatter and plugin manifest schemas that mirror the marketplace-required fields without importing peer L2 packages.
- [ ] Implement deterministic trust scoring from downloads, rating, publisher reputation, and security findings.
- [ ] Run `bun test packages/net/community-registry/src/handler.test.ts` and confirm the publish tests pass.

### Task 3: Backend, Discovery, And Search

**Files:**
- Create: `packages/net/community-registry/src/memory-backend.ts`
- Create: `packages/net/community-registry/src/search.ts`
- Test: `packages/net/community-registry/src/handler.test.ts`

- [ ] Write failing tests for categorized discovery and relevant search.
- [ ] Implement immutable in-memory publish, get, list versions, search, discovery, and install recording.
- [ ] Implement simple weighted full-text ranking.
- [ ] Run the targeted test file and confirm discovery/search pass.

### Task 4: HTTP Handler And Install Flow

**Files:**
- Create: `packages/net/community-registry/src/handler.ts`
- Test: `packages/net/community-registry/src/handler.test.ts`

- [ ] Write failing tests for successful install, checksum mismatch, size mismatch, caret-range compatibility, and incompatible Koi version.
- [ ] Implement route dispatch, JSON/error helpers, auth checks, install artifact download, artifact size validation, SHA-256 validation, compatibility checks, and installer callback integration.
- [ ] Run the targeted test file and confirm install tests pass.

### Task 5: Verification

**Files:**
- Modify as needed from earlier tasks.

- [ ] Run `bun test packages/net/community-registry`.
- [ ] Run `bun run typecheck --filter=@koi/community-registry` if supported, otherwise `cd packages/net/community-registry && bun run typecheck`.
- [ ] Run `bun run check:layers`.
- [ ] Fix any issues and rerun the failing command.
