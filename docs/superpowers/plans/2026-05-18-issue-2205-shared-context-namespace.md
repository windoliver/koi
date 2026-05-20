# Issue 2205 Shared Context Namespace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first shared context namespace contract and in-memory implementation for `/shared/` style multi-agent context.

**Architecture:** Add L0 contract types in `@koi/core`, then implement `createContextNamespace()` in `@koi/fs-scoped` using the existing scoped filesystem wrapper for read-only/read-write access. Keep spawn composition indirect through shared world-service components rather than direct parent-child communication.

**Tech Stack:** Bun, TypeScript 6 strict mode, `bun:test`, `@koi/core`, `@koi/fs-scoped`.

---

### Task 1: L0 Context Namespace Contract

**Files:**
- Create: `packages/kernel/core/src/context-namespace.ts`
- Modify: `packages/kernel/core/src/index.ts`
- Modify: `packages/kernel/core/package.json`
- Modify: `packages/kernel/core/tsup.config.ts`
- Modify: `packages/kernel/core/src/__tests__/exports.test.ts`

- [ ] **Step 1: Write the failing export/type test**

Add `ContextNamespace`, `ContextNamespaceAccessMode`, `ContextNamespaceChangeEvent`, and `ContextNamespaceMount` to the type import list in `packages/kernel/core/src/__tests__/exports.test.ts`, and add each to the `_TypeGuard` union.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/exports.test.ts` from `packages/kernel/core`.

Expected: FAIL because the new types are not exported from `../index.js`.

- [ ] **Step 3: Add the L0 contract**

Create `packages/kernel/core/src/context-namespace.ts` with readonly interfaces only, importing `FileSystemBackend` from `./filesystem-backend.js`.

- [ ] **Step 4: Export the contract**

Export the new types from `packages/kernel/core/src/index.ts`, add `./context-namespace` to `packages/kernel/core/package.json`, and add `src/context-namespace.ts` to `packages/kernel/core/tsup.config.ts`.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/__tests__/exports.test.ts` from `packages/kernel/core`.

Expected: PASS.

### Task 2: In-Memory Namespace Implementation

**Files:**
- Create: `packages/lib/fs-scoped/src/context-namespace.ts`
- Create: `packages/lib/fs-scoped/src/context-namespace.test.ts`
- Modify: `packages/lib/fs-scoped/src/index.ts`

- [ ] **Step 1: Write failing behavior tests**

Add tests for mount/list/unmount, longest-prefix resolution, read-only write rejection, read-write write success, watcher events, and stable `/shared/` visibility through one shared namespace instance.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/context-namespace.test.ts` from `packages/lib/fs-scoped`.

Expected: FAIL because `createContextNamespace()` does not exist.

- [ ] **Step 3: Implement minimal namespace manager**

Implement path normalization, mount replacement, longest-prefix matching, scoped backend creation, and watcher notification in `packages/lib/fs-scoped/src/context-namespace.ts`.

- [ ] **Step 4: Export implementation**

Export `createContextNamespace()` from `packages/lib/fs-scoped/src/index.ts`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/context-namespace.test.ts` from `packages/lib/fs-scoped`.

Expected: PASS.

### Task 3: Docs, API Surface, And Verification

**Files:**
- Modify: `docs/L2/fs-scoped.md`
- Modify generated snapshots under `packages/kernel/core/src/__tests__/__snapshots__/api-surface.test.ts.snap`

- [ ] **Step 1: Document namespace behavior**

Update `docs/L2/fs-scoped.md` with the shared context namespace contract, `/shared/` example, access modes, and change notification behavior.

- [ ] **Step 2: Build core and update API surface snapshots**

Run: `bun --cwd packages/kernel/core run build` from repo root, then `bun test src/__tests__/api-surface.test.ts` from `packages/kernel/core`.

Expected: snapshots update for the new `./context-namespace` export.

- [ ] **Step 3: Run focused verification**

Run:

```bash
bun --cwd packages/kernel/core run build
bun test src/__tests__/exports.test.ts src/__tests__/api-surface.test.ts
bun test src/context-namespace.test.ts
bun run check:layers
```

Expected: all commands pass.
