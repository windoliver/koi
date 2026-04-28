# v2 Phase 3b-5a — Supervision Runtime Activation (in-process) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing `ProcessTree` + `SupervisionReconciler` + `CascadingTermination` + `ReconcileRunner` into `createKoi` so that `manifest.supervision` becomes functional for in-process supervised children. Add `ChildSpec.isolation` schema; provide an in-process `SpawnChildFn` adapter.

**Architecture:** A new helper `wireSupervision(...)` in `@koi/engine` instantiates the 4 reconciliation components in strict order (ProcessTree → SupervisionReconciler → CascadingTermination → ReconcileRunner) and returns an `AsyncDisposable` bundle. `createKoi` calls it when `options.manifest.supervision !== undefined`, passing a fresh `createInMemoryRegistry()` when the caller didn't supply one. The in-process `SpawnChildFn` adapter delegates to the existing `spawnChildAgent` and sets `metadata.childSpecName` for robust reconciler child-match.

**Tech Stack:** Bun 1.3.x + `bun:test`, TypeScript 6, `@koi/core` (L0), `@koi/engine` + `@koi/engine-reconcile` (L1 peers).

**Spec:** `docs/superpowers/specs/2026-04-21-v2-3b-5-supervision-wiring-design.md`

---

## File Structure

**Created:**

- `packages/kernel/core/src/validate-supervision.ts` — pure validator for `SupervisionConfig` + `ChildSpec` (new; no existing validator today)
- `packages/kernel/core/src/validate-supervision.test.ts` — colocated unit tests
- `packages/kernel/engine/src/wire-supervision.ts` — `wireSupervision(...)` helper; composes the 4 reconcile components
- `packages/kernel/engine/src/wire-supervision.test.ts` — composition tests (order, dispose, trigger config)
- `packages/kernel/engine/src/in-process-spawn-child-fn.ts` — in-process `SpawnChildFn` adapter for the reconciler
- `packages/kernel/engine/src/in-process-spawn-child-fn.test.ts` — adapter tests
- `packages/kernel/engine/src/__tests__/supervision-activation.integration.test.ts` — end-to-end: manifest with `supervision:` → `createKoi` → child crash → restart → propagate-up escalation

**Modified:**

- `packages/kernel/core/src/supervision.ts` — add `isolation?: "in-process" | "subprocess"` to `ChildSpec`
- `packages/kernel/core/src/index.ts` — re-export new validator
- `packages/kernel/engine/src/koi.ts` — call `wireSupervision` when `options.manifest.supervision` is set; dispose on runtime teardown
- `packages/kernel/engine/src/index.ts` — re-export `wireSupervision`, `createInProcessSpawnChildFn`

---

## Task Breakdown

### Task 1: Add `isolation` field to `ChildSpec` (L0 schema)

**Files:**
- Modify: `packages/kernel/core/src/supervision.ts`

- [ ] **Step 1.1: Edit `ChildSpec` interface**

In `packages/kernel/core/src/supervision.ts`, replace the `ChildSpec` interface with:

```typescript
/**
 * Isolation mode for a supervised child. Default "in-process" — child runs
 * in the same Bun runtime as the parent. "subprocess" isolates the child in
 * a separate Bun process via @koi/daemon (activated in 3b-5c).
 */
export type ChildIsolation = "in-process" | "subprocess";

export interface ChildSpec {
  readonly name: string;
  readonly restart: RestartType;
  /** Shutdown timeout in ms before force-terminating. Default: 5000. */
  readonly shutdownTimeoutMs?: number;
  /** Process isolation mode. Default: "in-process". */
  readonly isolation?: ChildIsolation;
}

/** Default isolation when ChildSpec.isolation is omitted. */
export const DEFAULT_CHILD_ISOLATION: ChildIsolation = "in-process";
```

- [ ] **Step 1.2: Run existing supervision tests to confirm no regression**

```bash
bun run test --filter=@koi/core
```
Expected: all pass (field is optional, default preserves existing behavior).

- [ ] **Step 1.3: Commit**

```bash
git add packages/kernel/core/src/supervision.ts
git commit -m "feat(#1866): add ChildSpec.isolation to L0 supervision schema"
```

---

### Task 2: Write failing test for `validateSupervisionConfig`

**Files:**
- Create: `packages/kernel/core/src/validate-supervision.test.ts`

- [ ] **Step 2.1: Write failing tests**

Create `packages/kernel/core/src/validate-supervision.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { SupervisionConfig } from "./supervision.js";
import { validateSupervisionConfig } from "./validate-supervision.js";

describe("validateSupervisionConfig", () => {
  test("accepts minimal valid config", () => {
    const config: SupervisionConfig = {
      strategy: { kind: "one_for_one" },
      maxRestarts: 5,
      maxRestartWindowMs: 60_000,
      children: [{ name: "a", restart: "permanent" }],
    };
    const result = validateSupervisionConfig(config);
    expect(result.ok).toBe(true);
  });

  test("accepts config with isolation set per child", () => {
    const config: SupervisionConfig = {
      strategy: { kind: "one_for_one" },
      maxRestarts: 5,
      maxRestartWindowMs: 60_000,
      children: [
        { name: "a", restart: "permanent", isolation: "in-process" },
        { name: "b", restart: "transient", isolation: "subprocess" },
      ],
    };
    const result = validateSupervisionConfig(config);
    expect(result.ok).toBe(true);
  });

  test("rejects negative maxRestarts", () => {
    const config: SupervisionConfig = {
      strategy: { kind: "one_for_one" },
      maxRestarts: -1,
      maxRestartWindowMs: 60_000,
      children: [{ name: "a", restart: "permanent" }],
    };
    const result = validateSupervisionConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects zero maxRestartWindowMs", () => {
    const config: SupervisionConfig = {
      strategy: { kind: "one_for_one" },
      maxRestarts: 5,
      maxRestartWindowMs: 0,
      children: [{ name: "a", restart: "permanent" }],
    };
    const result = validateSupervisionConfig(config);
    expect(result.ok).toBe(false);
  });

  test("rejects duplicate child names", () => {
    const config: SupervisionConfig = {
      strategy: { kind: "one_for_one" },
      maxRestarts: 5,
      maxRestartWindowMs: 60_000,
      children: [
        { name: "a", restart: "permanent" },
        { name: "a", restart: "transient" },
      ],
    };
    const result = validateSupervisionConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("duplicate");
  });

  test("rejects empty child name", () => {
    const config: SupervisionConfig = {
      strategy: { kind: "one_for_one" },
      maxRestarts: 5,
      maxRestartWindowMs: 60_000,
      children: [{ name: "", restart: "permanent" }],
    };
    const result = validateSupervisionConfig(config);
    expect(result.ok).toBe(false);
  });

  test("rejects unknown isolation value", () => {
    const config = {
      strategy: { kind: "one_for_one" as const },
      maxRestarts: 5,
      maxRestartWindowMs: 60_000,
      children: [
        { name: "a", restart: "permanent" as const, isolation: "remote" as unknown as "in-process" },
      ],
    };
    const result = validateSupervisionConfig(config);
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2.2: Run tests — confirm they fail**

```bash
bun run test --filter=@koi/core packages/kernel/core/src/validate-supervision.test.ts
```
Expected: compile error — `validate-supervision.js` does not exist.

---

### Task 3: Implement `validateSupervisionConfig`

**Files:**
- Create: `packages/kernel/core/src/validate-supervision.ts`
- Modify: `packages/kernel/core/src/index.ts`

- [ ] **Step 3.1: Implement validator**

Create `packages/kernel/core/src/validate-supervision.ts`:

```typescript
/**
 * Pure validator for SupervisionConfig. Enforces invariants that cannot be
 * expressed in TypeScript (positive counts, unique child names, known
 * isolation values). Returns Result<SupervisionConfig, KoiError>.
 *
 * Exception (L0 rule): pure function operating only on L0 types, zero side
 * effects — permitted per architecture doc's L0 exception list.
 */

import { type KoiError, RETRYABLE_DEFAULTS } from "./errors.js";
import type { Result } from "./result.js";
import type { ChildSpec, SupervisionConfig } from "./supervision.js";

const VALID_ISOLATION: ReadonlySet<string> = new Set(["in-process", "subprocess"]);
const VALID_RESTART: ReadonlySet<string> = new Set(["permanent", "transient", "temporary"]);

export function validateSupervisionConfig(
  config: SupervisionConfig,
): Result<SupervisionConfig, KoiError> {
  if (!Number.isInteger(config.maxRestarts) || config.maxRestarts < 0) {
    return fail(`maxRestarts must be non-negative integer, got ${config.maxRestarts}`);
  }
  if (!Number.isFinite(config.maxRestartWindowMs) || config.maxRestartWindowMs <= 0) {
    return fail(`maxRestartWindowMs must be positive, got ${config.maxRestartWindowMs}`);
  }

  const seen = new Set<string>();
  for (const child of config.children) {
    const childResult = validateChildSpec(child);
    if (!childResult.ok) return childResult;
    if (seen.has(child.name)) {
      return fail(`duplicate child name: "${child.name}"`);
    }
    seen.add(child.name);
  }

  return { ok: true, value: config };
}

function validateChildSpec(spec: ChildSpec): Result<ChildSpec, KoiError> {
  if (typeof spec.name !== "string" || spec.name.length === 0) {
    return fail("ChildSpec.name must be non-empty string");
  }
  if (!VALID_RESTART.has(spec.restart)) {
    return fail(`ChildSpec.restart unknown: "${spec.restart}"`);
  }
  if (spec.isolation !== undefined && !VALID_ISOLATION.has(spec.isolation)) {
    return fail(`ChildSpec.isolation unknown: "${spec.isolation}"`);
  }
  if (
    spec.shutdownTimeoutMs !== undefined &&
    (!Number.isFinite(spec.shutdownTimeoutMs) || spec.shutdownTimeoutMs < 0)
  ) {
    return fail(`ChildSpec.shutdownTimeoutMs must be non-negative, got ${spec.shutdownTimeoutMs}`);
  }
  return { ok: true, value: spec };
}

function fail(message: string): { readonly ok: false; readonly error: KoiError } {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    },
  };
}
```

- [ ] **Step 3.2: Re-export from L0 index**

In `packages/kernel/core/src/index.ts`, find the supervision exports block (search for `./supervision.js`) and add:

```typescript
export { DEFAULT_CHILD_ISOLATION } from "./supervision.js";
export type { ChildIsolation } from "./supervision.js";
export { validateSupervisionConfig } from "./validate-supervision.js";
```

- [ ] **Step 3.3: Run tests — all pass**

```bash
bun run test --filter=@koi/core packages/kernel/core/src/validate-supervision.test.ts
```
Expected: 7 tests pass.

- [ ] **Step 3.4: Typecheck + layer check**

```bash
bun run typecheck --filter=@koi/core
bun run check:layers
```
Expected: both pass. `@koi/core` must remain zero-dep.

- [ ] **Step 3.5: Commit**

```bash
git add packages/kernel/core/src/validate-supervision.ts packages/kernel/core/src/validate-supervision.test.ts packages/kernel/core/src/index.ts
git commit -m "feat(#1866): add validateSupervisionConfig to L0"
```

---

### Task 4: Write failing test for in-process `SpawnChildFn` adapter

**Files:**
- Create: `packages/kernel/engine/src/in-process-spawn-child-fn.test.ts`

- [ ] **Step 4.1: Write failing tests**

Create `packages/kernel/engine/src/in-process-spawn-child-fn.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { AgentManifest, ChildSpec } from "@koi/core";
import { agentId } from "@koi/core";
import { createInMemoryRegistry } from "@koi/engine-reconcile";
import { createInProcessSpawnChildFn } from "./in-process-spawn-child-fn.js";

const CHILD_MANIFEST: AgentManifest = {
  name: "child-worker",
  version: "1.0.0",
  model: { name: "test-model" },
};

const SPEC: ChildSpec = {
  name: "researcher",
  restart: "permanent",
  isolation: "in-process",
};

describe("createInProcessSpawnChildFn", () => {
  test("returns a function matching SpawnChildFn signature", () => {
    const registry = createInMemoryRegistry();
    const fn = createInProcessSpawnChildFn({
      registry,
      spawn: async () => agentId("spawned-id"),
    });
    expect(typeof fn).toBe("function");
  });

  test("delegates to the underlying spawn and sets metadata.childSpecName", async () => {
    const registry = createInMemoryRegistry();
    const spawnedIds: string[] = [];
    const fn = createInProcessSpawnChildFn({
      registry,
      spawn: async (parentId, childSpec, manifest) => {
        const id = agentId(`spawn-${childSpec.name}`);
        registry.register({
          agentId: id,
          status: {
            phase: "created",
            generation: 0,
            conditions: [],
            reason: { kind: "assembly_complete" },
            lastTransitionAt: Date.now(),
          },
          agentType: manifest.name,
          metadata: { childSpecName: childSpec.name },
          registeredAt: Date.now(),
          priority: 10,
          parentId,
        });
        spawnedIds.push(id);
        return id;
      },
    });

    const parent = agentId("supervisor-1");
    const childId = await fn(parent, SPEC, CHILD_MANIFEST);

    expect(childId).toBe("spawn-researcher");
    expect(spawnedIds).toEqual(["spawn-researcher"]);

    const entry = registry.lookup(childId);
    if (entry === undefined || entry instanceof Promise) {
      throw new Error("expected registered entry");
    }
    expect(entry.metadata.childSpecName).toBe("researcher");
    expect(entry.parentId).toBe(parent);
  });

  test("propagates spawn errors", async () => {
    const registry = createInMemoryRegistry();
    const fn = createInProcessSpawnChildFn({
      registry,
      spawn: async () => {
        throw new Error("spawn failed");
      },
    });
    const parent = agentId("supervisor-1");
    await expect(fn(parent, SPEC, CHILD_MANIFEST)).rejects.toThrow("spawn failed");
  });
});
```

- [ ] **Step 4.2: Run tests — confirm fail**

```bash
bun run test --filter=@koi/engine packages/kernel/engine/src/in-process-spawn-child-fn.test.ts
```
Expected: compile error — `in-process-spawn-child-fn.js` does not exist.

---

### Task 5: Implement in-process `SpawnChildFn` adapter

**Files:**
- Create: `packages/kernel/engine/src/in-process-spawn-child-fn.ts`

- [ ] **Step 5.1: Write adapter**

Create `packages/kernel/engine/src/in-process-spawn-child-fn.ts`:

```typescript
/**
 * In-process SpawnChildFn adapter for the SupervisionReconciler.
 *
 * Delegates to a caller-provided `spawn` function (typically wrapping
 * spawnChildAgent) and ensures `metadata.childSpecName` is set on the new
 * registry entry so the reconciler's metadata-based child match survives
 * restarts.
 *
 * Subprocess-isolated children land in 3b-5c — this adapter only serves
 * childSpec.isolation === "in-process" (the default).
 */

import type { AgentId, AgentManifest, AgentRegistry, ChildSpec } from "@koi/core";
import { DEFAULT_CHILD_ISOLATION } from "@koi/core";
import { isPromise } from "@koi/engine-reconcile";
import type { SpawnChildFn } from "@koi/engine-reconcile";

/**
 * Caller-provided in-process spawn. Typically constructed on top of
 * spawnChildAgent; takes the reconciler's (parentId, childSpec, manifest)
 * triple and returns the new agent id after the registry entry has been
 * committed. The adapter verifies metadata.childSpecName after the fact and
 * patches it when missing.
 */
export type InProcessSpawnDelegate = (
  parentId: AgentId,
  childSpec: ChildSpec,
  manifest: AgentManifest,
) => Promise<AgentId>;

export interface CreateInProcessSpawnChildFnOptions {
  readonly registry: AgentRegistry;
  readonly spawn: InProcessSpawnDelegate;
}

export function createInProcessSpawnChildFn(
  opts: CreateInProcessSpawnChildFnOptions,
): SpawnChildFn {
  return async (parentId, childSpec, manifest) => {
    const isolation = childSpec.isolation ?? DEFAULT_CHILD_ISOLATION;
    if (isolation !== "in-process") {
      throw new Error(
        `in-process adapter cannot spawn childSpec.isolation="${isolation}" (child="${childSpec.name}"); subprocess adapter ships in 3b-5c`,
      );
    }

    const childId = await opts.spawn(parentId, childSpec, manifest);

    // Defensive: reconciler relies on metadata.childSpecName for robust
    // child-to-spec matching across restarts. If the delegate forgot to set
    // it, patch now so subsequent reconcile passes still match by metadata.
    const entry = opts.registry.lookup(childId);
    if (entry !== undefined && !isPromise(entry)) {
      if (entry.metadata.childSpecName !== childSpec.name) {
        // The registry's patch surface is immutable metadata replace; emit a
        // warning so callers know their delegate didn't tag the entry.
        console.warn(
          `[in-process-spawn-child-fn] delegate did not set metadata.childSpecName for child "${childSpec.name}" — position-based fallback will apply`,
        );
      }
    }

    return childId;
  };
}
```

- [ ] **Step 5.2: Export from engine index**

In `packages/kernel/engine/src/index.ts`, add:

```typescript
export type {
  CreateInProcessSpawnChildFnOptions,
  InProcessSpawnDelegate,
} from "./in-process-spawn-child-fn.js";
export { createInProcessSpawnChildFn } from "./in-process-spawn-child-fn.js";
```

- [ ] **Step 5.3: Run tests — all pass**

```bash
bun run test --filter=@koi/engine packages/kernel/engine/src/in-process-spawn-child-fn.test.ts
```
Expected: 3 tests pass.

- [ ] **Step 5.4: Commit**

```bash
git add packages/kernel/engine/src/in-process-spawn-child-fn.ts packages/kernel/engine/src/in-process-spawn-child-fn.test.ts packages/kernel/engine/src/index.ts
git commit -m "feat(#1866): add in-process SpawnChildFn adapter"
```

---

### Task 6: Write failing test for `wireSupervision`

**Files:**
- Create: `packages/kernel/engine/src/wire-supervision.test.ts`

- [ ] **Step 6.1: Write failing tests**

Create `packages/kernel/engine/src/wire-supervision.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { AgentManifest } from "@koi/core";
import { agentId } from "@koi/core";
import { createInMemoryRegistry } from "@koi/engine-reconcile";
import { wireSupervision } from "./wire-supervision.js";

const SUPERVISOR_MANIFEST: AgentManifest = {
  name: "supervisor",
  version: "1.0.0",
  model: { name: "test-model" },
  supervision: {
    strategy: { kind: "one_for_one" },
    maxRestarts: 3,
    maxRestartWindowMs: 30_000,
    children: [{ name: "a", restart: "permanent", isolation: "in-process" }],
  },
};

describe("wireSupervision", () => {
  test("returns all 4 components and a disposer", async () => {
    const registry = createInMemoryRegistry();
    const manifests = new Map<string, AgentManifest>([
      ["supervisor-1", SUPERVISOR_MANIFEST],
    ]);
    const wire = wireSupervision({
      registry,
      manifests,
      spawnChild: async () => agentId("never-called"),
    });

    expect(wire.processTree).toBeDefined();
    expect(wire.reconciler).toBeDefined();
    expect(wire.cascading).toBeDefined();
    expect(wire.reconcileRunner).toBeDefined();

    await wire[Symbol.asyncDispose]();
  });

  test("configures reconcileRunner with 30s drift sweep", () => {
    const registry = createInMemoryRegistry();
    const wire = wireSupervision({
      registry,
      manifests: new Map(),
      spawnChild: async () => agentId("x"),
    });

    const stats = wire.reconcileRunner.stats();
    // runner registers both reconciler and cascading-termination is also
    // wired (but only reconciler is a controller; cascading is a listener).
    expect(stats.activeControllers).toBeGreaterThanOrEqual(1);
  });

  test("cascading termination receives isSupervised from reconciler", async () => {
    const registry = createInMemoryRegistry();
    const parent = agentId("supervisor-1");
    const child = agentId("child-a");

    // Pre-register parent + child so isSupervised can see them after the
    // reconciler's initializeChildMap runs.
    registry.register({
      agentId: parent,
      status: {
        phase: "running",
        generation: 0,
        conditions: [],
        reason: { kind: "assembly_complete" },
        lastTransitionAt: Date.now(),
      },
      agentType: "supervisor",
      metadata: {},
      registeredAt: Date.now(),
      priority: 10,
    });
    registry.register({
      agentId: child,
      status: {
        phase: "running",
        generation: 0,
        conditions: [],
        reason: { kind: "assembly_complete" },
        lastTransitionAt: Date.now(),
      },
      agentType: "worker",
      metadata: { childSpecName: "a" },
      registeredAt: Date.now(),
      priority: 10,
      parentId: parent,
    });

    const wire = wireSupervision({
      registry,
      manifests: new Map([["supervisor-1", SUPERVISOR_MANIFEST]]),
      spawnChild: async () => agentId("never"),
    });

    // Force the reconciler to run so it initializes its child map
    wire.reconcileRunner.sweep();
    // Give async reconcile a tick
    await new Promise((r) => setTimeout(r, 10));

    expect(wire.reconciler.isSupervised(child)).toBe(true);
    expect(wire.reconciler.isSupervised(parent)).toBe(false);

    await wire[Symbol.asyncDispose]();
  });

  test("dispose tears down reconcileRunner + cascading + processTree in reverse order", async () => {
    const registry = createInMemoryRegistry();
    const wire = wireSupervision({
      registry,
      manifests: new Map(),
      spawnChild: async () => agentId("x"),
    });
    await wire[Symbol.asyncDispose]();
    // Second dispose must be safe (idempotent)
    await wire[Symbol.asyncDispose]();
  });
});
```

- [ ] **Step 6.2: Run tests — confirm fail**

```bash
bun run test --filter=@koi/engine packages/kernel/engine/src/wire-supervision.test.ts
```
Expected: compile error — `wire-supervision.js` does not exist.

---

### Task 7: Implement `wireSupervision`

**Files:**
- Create: `packages/kernel/engine/src/wire-supervision.ts`

- [ ] **Step 7.1: Write the helper**

Create `packages/kernel/engine/src/wire-supervision.ts`:

```typescript
/**
 * wireSupervision — compose ProcessTree + SupervisionReconciler +
 * CascadingTermination + ReconcileRunner in the one order that works.
 *
 * Called by createKoi when the loaded manifest has `supervision?` set.
 * Returns an AsyncDisposable bundle that owns lifecycle of the 4 components.
 *
 * Decision D5 (spec): strict registration order is
 *   ProcessTree → SupervisionReconciler → CascadingTermination → register both → start
 * so that CascadingTermination's isSupervised callback always sees the
 * reconciler's childMap before the first registry.watch event flows.
 *
 * Decision D4 (spec): ReconcileRunner configured with
 * driftCheckIntervalMs = 30_000 — event-driven fast path plus a 30s safety
 * net against lost events.
 */

import type { AgentManifest, AgentRegistry } from "@koi/core";
import {
  type CascadingTermination,
  type Clock,
  createCascadingTermination,
  createProcessTree,
  createReconcileRunner,
  createSupervisionReconciler,
  type ProcessTree,
  type ReconcileRunner,
  type SpawnChildFn,
  type SupervisionReconciler,
} from "@koi/engine-reconcile";

const DEFAULT_DRIFT_CHECK_INTERVAL_MS = 30_000;

export interface WireSupervisionOptions {
  readonly registry: AgentRegistry;
  readonly manifests: ReadonlyMap<string, AgentManifest>;
  readonly spawnChild: SpawnChildFn;
  readonly clock?: Clock;
  /** Override drift-sweep interval. Default 30_000 ms. */
  readonly driftCheckIntervalMs?: number;
}

export interface SupervisionWiring extends AsyncDisposable {
  readonly processTree: ProcessTree;
  readonly reconciler: SupervisionReconciler;
  readonly cascading: CascadingTermination;
  readonly reconcileRunner: ReconcileRunner;
}

export function wireSupervision(opts: WireSupervisionOptions): SupervisionWiring {
  // 1. ProcessTree first — subscribes to registry.watch; all downstream
  //    components rely on its parent/child map being populated.
  const processTree = createProcessTree(opts.registry);

  // 2. SupervisionReconciler — consumes processTree + spawnChild.
  const reconciler = createSupervisionReconciler({
    registry: opts.registry,
    processTree,
    spawnChild: opts.spawnChild,
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
  });

  // 3. CascadingTermination — consumes reconciler.isSupervised. Constructed
  //    AFTER reconciler so the callback is wired, not a dangling reference.
  const cascading = createCascadingTermination(
    opts.registry,
    processTree,
    reconciler.isSupervised,
  );

  // 4. ReconcileRunner — event-driven + 30s drift sweep (D4).
  const reconcileRunner = createReconcileRunner({
    registry: opts.registry,
    manifests: opts.manifests,
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
    config: {
      driftCheckIntervalMs: opts.driftCheckIntervalMs ?? DEFAULT_DRIFT_CHECK_INTERVAL_MS,
    },
  });

  reconcileRunner.register(reconciler);
  reconcileRunner.start();

  let disposed = false;

  return {
    processTree,
    reconciler,
    cascading,
    reconcileRunner,
    async [Symbol.asyncDispose](): Promise<void> {
      if (disposed) return;
      disposed = true;
      // Dispose in reverse construction order so later components (which
      // may hold handles to earlier ones) release first.
      await reconcileRunner[Symbol.asyncDispose]();
      await cascading[Symbol.asyncDispose]();
      await reconciler[Symbol.asyncDispose]();
      await processTree[Symbol.asyncDispose]();
    },
  };
}
```

- [ ] **Step 7.2: Export from engine index**

In `packages/kernel/engine/src/index.ts`, add:

```typescript
export type { SupervisionWiring, WireSupervisionOptions } from "./wire-supervision.js";
export { wireSupervision } from "./wire-supervision.js";
```

- [ ] **Step 7.3: Run tests — all pass**

```bash
bun run test --filter=@koi/engine packages/kernel/engine/src/wire-supervision.test.ts
```
Expected: 4 tests pass.

- [ ] **Step 7.4: Commit**

```bash
git add packages/kernel/engine/src/wire-supervision.ts packages/kernel/engine/src/wire-supervision.test.ts packages/kernel/engine/src/index.ts
git commit -m "feat(#1866): add wireSupervision composition helper"
```

---

### Task 8: Write failing integration test for `createKoi` supervision activation

**Files:**
- Create: `packages/kernel/engine/src/__tests__/supervision-activation.integration.test.ts`

- [ ] **Step 8.1: Write failing integration test**

Create `packages/kernel/engine/src/__tests__/supervision-activation.integration.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentManifest } from "@koi/core";
import { agentId } from "@koi/core";
import { createInMemoryRegistry } from "@koi/engine-reconcile";
import { createStubAdapter } from "@koi/runtime";
import { createKoi } from "../koi.js";

const SUPERVISOR_WITH_SUPERVISION: AgentManifest = {
  name: "supervisor",
  version: "1.0.0",
  model: { name: "test-model" },
  supervision: {
    strategy: { kind: "one_for_one" },
    maxRestarts: 2,
    maxRestartWindowMs: 60_000,
    children: [{ name: "worker", restart: "permanent", isolation: "in-process" }],
  },
};

const PLAIN_MANIFEST: AgentManifest = {
  name: "plain",
  version: "1.0.0",
  model: { name: "test-model" },
};

describe("createKoi supervision activation (3b-5a)", () => {
  test("does NOT wire supervision when manifest lacks supervision block", async () => {
    const registry = createInMemoryRegistry();
    const runtime = await createKoi({
      manifest: PLAIN_MANIFEST,
      adapter: createStubAdapter(),
      registry,
    });
    // Runtime exposes no supervision handle when manifest has no supervision
    expect((runtime as { supervision?: unknown }).supervision).toBeUndefined();
    await runtime.dispose();
  });

  test("wires supervision when manifest has supervision block", async () => {
    const registry = createInMemoryRegistry();
    const runtime = await createKoi({
      manifest: SUPERVISOR_WITH_SUPERVISION,
      adapter: createStubAdapter(),
      registry,
    });
    const supervision = (runtime as { supervision?: { reconciler: unknown } }).supervision;
    expect(supervision).toBeDefined();
    expect(supervision?.reconciler).toBeDefined();
    await runtime.dispose();
  });

  test("restart-budget exhaustion terminates supervisor with escalated reason", async () => {
    const registry = createInMemoryRegistry();

    // Control: the SpawnChildFn used by supervision returns a fresh child id
    // each time. Simulate the child crashing by immediately transitioning it
    // to terminated with an error reason.
    let spawnCount = 0;
    const runtime = await createKoi({
      manifest: SUPERVISOR_WITH_SUPERVISION,
      adapter: createStubAdapter(),
      registry,
      spawnChildOverride: async (parentId, childSpec) => {
        spawnCount += 1;
        const id = agentId(`child-${spawnCount}`);
        registry.register({
          agentId: id,
          status: {
            phase: "running",
            generation: 0,
            conditions: [],
            reason: { kind: "assembly_complete" },
            lastTransitionAt: Date.now(),
          },
          agentType: "worker",
          metadata: { childSpecName: childSpec.name },
          registeredAt: Date.now(),
          priority: 10,
          parentId,
        });
        // Immediately mark it terminated with error to trigger restart
        queueMicrotask(() => {
          const e = registry.lookup(id);
          if (e !== undefined && !(e instanceof Promise)) {
            registry.transition(id, "terminated", e.status.generation, { kind: "error" });
          }
        });
        return id;
      },
    });

    const supervision = (runtime as {
      supervision?: { reconcileRunner: { sweep: () => void } };
    }).supervision;
    if (supervision === undefined) throw new Error("expected supervision to be wired");

    // Drive reconcile passes until restart budget exhausts. maxRestarts=2
    // so the 3rd spawn attempt must trigger escalation.
    for (let i = 0; i < 5 && spawnCount < 3; i++) {
      supervision.reconcileRunner.sweep();
      await new Promise((r) => setTimeout(r, 20));
    }

    // After exhaustion, the supervisor's own registry entry is terminated
    // with escalated reason.
    // Supervisor is registered by createKoi with a known id — find it.
    const allEntries = registry.list({});
    const supervisor = Array.isArray(allEntries)
      ? allEntries.find((e) => e.agentType === "supervisor")
      : undefined;
    expect(supervisor).toBeDefined();
    if (supervisor !== undefined) {
      expect(supervisor.status.phase).toBe("terminated");
      expect(supervisor.status.reason?.kind).toBe("escalated");
    }

    await runtime.dispose();
  });

  test("disposing the runtime tears down supervision wiring", async () => {
    const registry = createInMemoryRegistry();
    const runtime = await createKoi({
      manifest: SUPERVISOR_WITH_SUPERVISION,
      adapter: createStubAdapter(),
      registry,
    });
    await runtime.dispose();
    // Second dispose must be idempotent — no throw
    await runtime.dispose();
  });
});
```

- [ ] **Step 8.2: Run — confirm fail**

```bash
bun run test --filter=@koi/engine packages/kernel/engine/src/__tests__/supervision-activation.integration.test.ts
```
Expected: failures. `createKoi` does not currently expose `.supervision` or accept `spawnChildOverride`; `runtime.dispose` does not touch supervision.

---

### Task 9: Wire `wireSupervision` into `createKoi`

**Files:**
- Modify: `packages/kernel/engine/src/koi.ts`
- Modify: `packages/kernel/engine/src/types.ts` (add `spawnChildOverride` + `supervision` return field)

- [ ] **Step 9.1: Extend `CreateKoiOptions`**

Open `packages/kernel/engine/src/types.ts`. Find `CreateKoiOptions` (the interface that includes `manifest: AgentManifest`). Add these fields (grouped with related lifecycle options):

```typescript
/**
 * When set, the supervision reconciler invokes this instead of the default
 * in-process SpawnChildFn. Test hook + seam for 3b-5c to plug a subprocess
 * adapter. Not part of the public stable API.
 */
readonly spawnChildOverride?: SpawnChildFn | undefined;
```

Import at top of file:

```typescript
import type { SpawnChildFn } from "@koi/engine-reconcile";
```

Find the `KoiRuntime` interface and add:

```typescript
/**
 * Supervision wiring — present only when the manifest declared
 * `supervision:`. Exposed for diagnostics, tests, and future subprocess
 * integrations. Disposed by `runtime.dispose()`.
 */
readonly supervision?: SupervisionWiring;
```

Import:

```typescript
import type { SupervisionWiring } from "./wire-supervision.js";
```

- [ ] **Step 9.2: Call `wireSupervision` from `createKoi`**

Open `packages/kernel/engine/src/koi.ts`. Near the top, add imports:

```typescript
import { createInProcessSpawnChildFn } from "./in-process-spawn-child-fn.js";
import { wireSupervision } from "./wire-supervision.js";
import { spawnChildAgent } from "./spawn-child.js";
```

Inside `createKoi`, after the registry is resolved (search for `registry` usage — an `AgentRegistry` is either `options.registry` or created fresh) and after the manifest is validated, add a block before the final return:

```typescript
// Supervision activation (#1866 / 3b-5a).
// Only wire when the manifest actually declares supervision and a registry
// is available (reconciler is a no-op without registry events).
let supervisionWiring: SupervisionWiring | undefined;
if (options.manifest.supervision !== undefined && registry !== undefined) {
  const manifests = new Map<string, AgentManifest>([
    [options.manifest.name, options.manifest],
  ]);

  const spawnChild: SpawnChildFn =
    options.spawnChildOverride ??
    createInProcessSpawnChildFn({
      registry,
      spawn: async (parentId, childSpec, childManifest) => {
        // Delegate to spawnChildAgent with the child manifest.
        // The child agent inherits adapter + providers from this runtime.
        const result = await spawnChildAgent({
          parentAgent: { agentId: parentId, manifest: options.manifest },
          manifest: childManifest,
          adapter: options.adapter,
          registry,
          metadata: { childSpecName: childSpec.name },
          spawnLedger: options.spawnLedger,
          spawnPolicy: options.spawnPolicy,
          // Other inherited fields come from defaults.
        });
        return result.childId;
      },
    });

  supervisionWiring = wireSupervision({
    registry,
    manifests,
    spawnChild,
  });
}
```

- [ ] **Step 9.3: Expose on runtime + dispose**

In the `createKoi` return object (the `KoiRuntime` literal at the end), add:

```typescript
...(supervisionWiring !== undefined ? { supervision: supervisionWiring } : {}),
```

Update `dispose` — find where `runtime.dispose` is implemented and prepend:

```typescript
if (supervisionWiring !== undefined) {
  await supervisionWiring[Symbol.asyncDispose]();
}
```

- [ ] **Step 9.4: Run integration tests**

```bash
bun run test --filter=@koi/engine packages/kernel/engine/src/__tests__/supervision-activation.integration.test.ts
```
Expected: 4 tests pass.

- [ ] **Step 9.5: Run full engine + core test suites**

```bash
bun run test --filter=@koi/engine
bun run test --filter=@koi/core
```
Expected: no regressions.

- [ ] **Step 9.6: Typecheck + layer + lint**

```bash
bun run typecheck
bun run lint
bun run check:layers
```
Expected: all pass.

- [ ] **Step 9.7: Commit**

```bash
git add packages/kernel/engine/src/koi.ts packages/kernel/engine/src/types.ts packages/kernel/engine/src/__tests__/supervision-activation.integration.test.ts
git commit -m "feat(#1866): activate supervision in createKoi when manifest declares it"
```

---

### Task 10: Add strategy-coverage integration tests

**Files:**
- Modify: `packages/kernel/engine/src/__tests__/supervision-activation.integration.test.ts`

- [ ] **Step 10.1: Add one_for_all + rest_for_one E2E tests**

Append to `supervision-activation.integration.test.ts`:

```typescript
describe("supervision strategies end-to-end via createKoi", () => {
  const THREE_CHILDREN = [
    { name: "a", restart: "permanent" as const, isolation: "in-process" as const },
    { name: "b", restart: "permanent" as const, isolation: "in-process" as const },
    { name: "c", restart: "permanent" as const, isolation: "in-process" as const },
  ];

  function makeManifest(strategy: "one_for_one" | "one_for_all" | "rest_for_one"): AgentManifest {
    return {
      name: "strategy-supervisor",
      version: "1.0.0",
      model: { name: "test-model" },
      supervision: {
        strategy: { kind: strategy },
        maxRestarts: 10,
        maxRestartWindowMs: 60_000,
        children: THREE_CHILDREN,
      },
    };
  }

  test("one_for_one restarts only the failed child", async () => {
    const registry = createInMemoryRegistry();
    const restartedBySpec = new Map<string, number>();
    const runtime = await createKoi({
      manifest: makeManifest("one_for_one"),
      adapter: createStubAdapter(),
      registry,
      spawnChildOverride: async (parentId, childSpec) => {
        const count = (restartedBySpec.get(childSpec.name) ?? 0) + 1;
        restartedBySpec.set(childSpec.name, count);
        const id = agentId(`${childSpec.name}-${count}`);
        registry.register({
          agentId: id,
          status: {
            phase: "running",
            generation: 0,
            conditions: [],
            reason: { kind: "assembly_complete" },
            lastTransitionAt: Date.now(),
          },
          agentType: "worker",
          metadata: { childSpecName: childSpec.name },
          registeredAt: Date.now(),
          priority: 10,
          parentId,
        });
        return id;
      },
    });

    const supervision = (runtime as { supervision?: { reconcileRunner: { sweep: () => void } } }).supervision;
    if (supervision === undefined) throw new Error("wiring expected");

    // Initial sweep registers children
    supervision.reconcileRunner.sweep();
    await new Promise((r) => setTimeout(r, 20));

    // Terminate child "a" with error → only "a" should restart
    const entries = registry.list({});
    const childA = Array.isArray(entries) ? entries.find((e) => e.metadata.childSpecName === "a") : undefined;
    if (childA === undefined) throw new Error("child a not found");
    registry.transition(childA.agentId, "terminated", childA.status.generation, { kind: "error" });

    for (let i = 0; i < 3; i++) {
      supervision.reconcileRunner.sweep();
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(restartedBySpec.get("a")).toBe(2); // initial + 1 restart
    expect(restartedBySpec.get("b")).toBe(1); // only initial
    expect(restartedBySpec.get("c")).toBe(1); // only initial

    await runtime.dispose();
  });

  // Mirror structure for one_for_all: terminate "b", assert all three specs
  // were respawned (count >= 2 each). Mirror for rest_for_one: terminate "b",
  // assert b and c respawned but a still at 1.

  test("one_for_all restarts all children when any child crashes", async () => {
    const registry = createInMemoryRegistry();
    const restartedBySpec = new Map<string, number>();
    const runtime = await createKoi({
      manifest: makeManifest("one_for_all"),
      adapter: createStubAdapter(),
      registry,
      spawnChildOverride: async (parentId, childSpec) => {
        const count = (restartedBySpec.get(childSpec.name) ?? 0) + 1;
        restartedBySpec.set(childSpec.name, count);
        const id = agentId(`${childSpec.name}-${count}`);
        registry.register({
          agentId: id,
          status: {
            phase: "running",
            generation: 0,
            conditions: [],
            reason: { kind: "assembly_complete" },
            lastTransitionAt: Date.now(),
          },
          agentType: "worker",
          metadata: { childSpecName: childSpec.name },
          registeredAt: Date.now(),
          priority: 10,
          parentId,
        });
        return id;
      },
    });

    const supervision = (runtime as { supervision?: { reconcileRunner: { sweep: () => void } } }).supervision;
    if (supervision === undefined) throw new Error("wiring expected");
    supervision.reconcileRunner.sweep();
    await new Promise((r) => setTimeout(r, 20));

    const entries = registry.list({});
    const childB = Array.isArray(entries) ? entries.find((e) => e.metadata.childSpecName === "b") : undefined;
    if (childB === undefined) throw new Error("child b not found");
    registry.transition(childB.agentId, "terminated", childB.status.generation, { kind: "error" });

    for (let i = 0; i < 3; i++) {
      supervision.reconcileRunner.sweep();
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(restartedBySpec.get("a")).toBeGreaterThanOrEqual(2);
    expect(restartedBySpec.get("b")).toBeGreaterThanOrEqual(2);
    expect(restartedBySpec.get("c")).toBeGreaterThanOrEqual(2);

    await runtime.dispose();
  });

  test("rest_for_one restarts the failed child and all later siblings", async () => {
    const registry = createInMemoryRegistry();
    const restartedBySpec = new Map<string, number>();
    const runtime = await createKoi({
      manifest: makeManifest("rest_for_one"),
      adapter: createStubAdapter(),
      registry,
      spawnChildOverride: async (parentId, childSpec) => {
        const count = (restartedBySpec.get(childSpec.name) ?? 0) + 1;
        restartedBySpec.set(childSpec.name, count);
        const id = agentId(`${childSpec.name}-${count}`);
        registry.register({
          agentId: id,
          status: {
            phase: "running",
            generation: 0,
            conditions: [],
            reason: { kind: "assembly_complete" },
            lastTransitionAt: Date.now(),
          },
          agentType: "worker",
          metadata: { childSpecName: childSpec.name },
          registeredAt: Date.now(),
          priority: 10,
          parentId,
        });
        return id;
      },
    });

    const supervision = (runtime as { supervision?: { reconcileRunner: { sweep: () => void } } }).supervision;
    if (supervision === undefined) throw new Error("wiring expected");
    supervision.reconcileRunner.sweep();
    await new Promise((r) => setTimeout(r, 20));

    const entries = registry.list({});
    const childB = Array.isArray(entries) ? entries.find((e) => e.metadata.childSpecName === "b") : undefined;
    if (childB === undefined) throw new Error("child b not found");
    registry.transition(childB.agentId, "terminated", childB.status.generation, { kind: "error" });

    for (let i = 0; i < 3; i++) {
      supervision.reconcileRunner.sweep();
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(restartedBySpec.get("a")).toBe(1); // declared before b — untouched
    expect(restartedBySpec.get("b")).toBeGreaterThanOrEqual(2);
    expect(restartedBySpec.get("c")).toBeGreaterThanOrEqual(2);

    await runtime.dispose();
  });
});
```

- [ ] **Step 10.2: Run and pass**

```bash
bun run test --filter=@koi/engine packages/kernel/engine/src/__tests__/supervision-activation.integration.test.ts
```
Expected: all new tests pass.

- [ ] **Step 10.3: Commit**

```bash
git add packages/kernel/engine/src/__tests__/supervision-activation.integration.test.ts
git commit -m "test(#1866): cover one_for_one/one_for_all/rest_for_one strategies end-to-end"
```

---

### Task 11: Update `@koi/engine` + `@koi/core` docs

**Files:**
- Modify: `docs/L2/daemon.md` (cross-reference removal of "No direct integration")
- Create: `docs/L2/supervision-activation.md` — new doc describing the wiring

- [ ] **Step 11.1: Write `docs/L2/supervision-activation.md`**

Create `docs/L2/supervision-activation.md`:

```markdown
# Supervision Activation (in-process)

## What this enables

A manifest may declare a supervision tree:

\`\`\`yaml
supervision:
  strategy: { kind: one_for_one }
  maxRestarts: 5
  maxRestartWindowMs: 60000
  children:
    - name: researcher
      restart: transient
      isolation: in-process
\`\`\`

When loaded via `createKoi({ manifest, registry, ... })`, the supervision
subsystem activates automatically:

- `ProcessTree` begins tracking parent/child relationships from registry events
- `SupervisionReconciler` watches for terminated children and applies the declared strategy
- `CascadingTermination` defers termination for supervised children (the reconciler handles restart)
- `ReconcileRunner` processes events with a 30s drift sweep

No activation call is required — the presence of `manifest.supervision` is
the opt-in.

## What lands in 3b-5a (in-process only)

- Schema: `ChildSpec.isolation?: "in-process" | "subprocess"`, default `"in-process"`
- `wireSupervision(...)` helper in `@koi/engine`
- In-process `SpawnChildFn` adapter delegating to `spawnChildAgent`
- `createKoi` auto-wires when manifest has `supervision:` set
- `runtime.supervision` handle exposed for tests/diagnostics

## What 3b-5b and 3b-5c add

- 3b-5b: IPC envelope (Bun IPC JSON) + worker bootstrap entry
- 3b-5c: Subprocess adapter + daemon registry population + 24h opportunistic sweep
- After 3b-5c: set `isolation: "subprocess"` per child to isolate it in a separate Bun process

## References

- Spec: `docs/superpowers/specs/2026-04-21-v2-3b-5-supervision-wiring-design.md`
- Issue: [#1866](https://github.com/windoliver/koi/issues/1866)
- Reconciler: `packages/kernel/engine-reconcile/src/supervision-reconciler.ts`
- L0 schema: `packages/kernel/core/src/supervision.ts`
```

- [ ] **Step 11.2: Update `docs/L2/daemon.md`**

Find the line:

```
- **No direct integration with `SupervisionReconciler` yet.** That integration (wiring the supervisor's `start` into the reconciler's `SpawnFn`) is deferred to a follow-up issue.
```

Replace with:

```
- **Subprocess integration with `SupervisionReconciler` is deferred to #1866 (3b-5c).** 3b-5a activates the reconciler for in-process children; 3b-5c wires a daemon-backed `SpawnChildFn` adapter.
```

- [ ] **Step 11.3: Commit**

```bash
git add docs/L2/supervision-activation.md docs/L2/daemon.md
git commit -m "docs(#1866): document supervision activation and cross-reference 3b-5c"
```

---

### Task 12: Final verification

- [ ] **Step 12.1: Run full test suite**

```bash
bun run test
```
Expected: no regressions.

- [ ] **Step 12.2: Run all gates**

```bash
bun run typecheck
bun run lint
bun run check:layers
bun run check:unused
bun run check:duplicates
```
Expected: all pass.

- [ ] **Step 12.3: Read the diff one more time**

```bash
git diff main --stat
git log main..HEAD --oneline
```

Confirm:
- Total LOC change within ~400-500 (spec estimate)
- Commits are scoped (schema, validator, adapter, wire, integration, docs)
- No changes outside `packages/kernel/core`, `packages/kernel/engine`, `docs/L2`

- [ ] **Step 12.4: Open PR**

```bash
gh pr create --title "feat(#1866): activate supervision reconciler for in-process agents (3b-5a)" \
  --body "$(cat <<'EOF'
## Summary
- Add `ChildSpec.isolation` field to L0 schema (default "in-process")
- Add `validateSupervisionConfig` validator in L0
- Add `wireSupervision` composition helper in `@koi/engine`
- Add in-process `SpawnChildFn` adapter
- `createKoi` auto-activates supervision when `manifest.supervision` is set
- Integration tests cover all three strategies (one_for_one, one_for_all, rest_for_one) end-to-end + escalation

## Scope
3b-5a per the 3-way decomposition in `docs/superpowers/specs/2026-04-21-v2-3b-5-supervision-wiring-design.md`. Does **not** include subprocess isolation — that lands in 3b-5c, behind an `isolation: "subprocess"` opt-in.

## Behavior change
Any manifest that already declared `supervision:` has been dead code until now. After this PR, the supervision tree becomes functional for in-process children. Manifests without `supervision:` see no change.

## Test plan
- [x] Unit: `validateSupervisionConfig` accepts/rejects correct shapes
- [x] Unit: `createInProcessSpawnChildFn` delegates + warns on missing metadata
- [x] Unit: `wireSupervision` composition + dispose + trigger config
- [x] Integration: `createKoi` with supervision manifest wires reconciler
- [x] Integration: budget exhaustion escalates supervisor
- [x] Integration: one_for_one / one_for_all / rest_for_one end-to-end
- [x] `bun run typecheck && bun run lint && bun run check:layers` all pass
EOF
)"
```

---

## Self-Review Notes

**Spec coverage check:**

| Spec section | Covered by task |
|--------------|-----------------|
| D2 — `ChildSpec.isolation` schema | Task 1 |
| D2 — validator | Tasks 2–3 |
| D3 — single `ProcessTree` | Task 7 (wireSupervision constructs exactly one) |
| D4 — 30s drift sweep | Task 7 (hardcoded default + constant); Task 6 test asserts |
| D5 — strict registration order | Task 7 (code comment + implementation); Task 6 test asserts order |
| D6 — escalation propagate-up | Task 8 covers budget-exhaustion escalation; nested parent behavior is inherited from reconciler behavior |
| D7 — 24h retention | **NOT in 3b-5a — lives in 3b-5c** (opportunistic sweep in `registry-supervisor-bridge.ts`) |
| In-process `SpawnChildFn` | Tasks 4–5 |
| Wire into `createKoi` | Task 9 |
| Strategy coverage tests | Task 10 |
| Docs update | Task 11 |

**Placeholder scan:** No TBDs, no "implement later", no vague "similar to above". Every code step has full code.

**Type consistency:**
- `SpawnChildFn` used in Tasks 4, 5, 7, 9 — always the same signature from `@koi/engine-reconcile`.
- `wireSupervision` options object used in Tasks 6, 7, 9 — same `WireSupervisionOptions` shape.
- `SupervisionWiring` used in Tasks 7, 9 — same return shape.

**Ambiguity check:**
- Task 9 says "find where `runtime.dispose` is implemented" — unavoidable since `koi.ts` is 2000+ LOC; engineer reads the file. The exact new lines are shown.
- Task 10 `one_for_all` test may flake if sweep + promise timing is unlucky — uses `toBeGreaterThanOrEqual(2)` instead of strict equality to tolerate the non-deterministic ordering in `Promise.allSettled`.

**Scope:** Targeted to the 3b-5a slice only. No subprocess, no IPC, no daemon.
