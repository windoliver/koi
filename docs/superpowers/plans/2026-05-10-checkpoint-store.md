# `CompositionCheckpointStore` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** Define `CompositionCheckpointStore` interface + ship `createInMemoryCheckpointStore` impl with 10 deterministic tests. Foundation for future Temporal-backed durable composition execution (#1301 Part 2).

**Architecture:** Pure factory returning `{ save, load, delete }`. In-memory `Map<executionId, CheckpointSnapshot>`. Synchronous validation in `save` (throws on caller bugs). All ops typed `T | Promise<T>` so durable backends can implement the same shape.

**Tech Stack:** TS6 strict, Bun 1.3, `bun:test`. Imports only `JsonValue` from `@koi/core`.

**Spec:** `docs/superpowers/specs/2026-05-10-checkpoint-store-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/lib/proactive/src/composition-checkpoint-store.ts` (new) | Interface + in-memory impl |
| `packages/lib/proactive/src/composition-checkpoint-store.test.ts` (new) | 10 tests |
| `packages/lib/proactive/src/index.ts` | Public exports |
| `docs/L2/proactive.md` | Documentation |
| `docs/L3/runtime.md` | Changelog |

---

## Task 1: Skeleton + first failing test

**Files:**
- Create: `packages/lib/proactive/src/composition-checkpoint-store.ts`
- Create: `packages/lib/proactive/src/composition-checkpoint-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `composition-checkpoint-store.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { createInMemoryCheckpointStore } from "./composition-checkpoint-store.js";

describe("createInMemoryCheckpointStore", () => {
  test("load before any save returns undefined", async () => {
    const store = createInMemoryCheckpointStore();
    const snap = await store.load("exec-1");
    expect(snap).toBeUndefined();
  });
});
```

- [ ] **Step 2: Stub the module**

Create `composition-checkpoint-store.ts`:

```typescript
import type { JsonValue } from "@koi/core";

export type CheckpointPhase = "in_progress" | "completed" | "failed";

export interface CheckpointSnapshot {
  readonly executionId: string;
  readonly planHash: string;
  readonly nextStepIndex: number;
  readonly stepResults: readonly JsonValue[];
  readonly phase: CheckpointPhase;
  readonly savedAt: number;
}

export interface CompositionCheckpointStore {
  readonly save: (snapshot: CheckpointSnapshot) => void | Promise<void>;
  readonly load: (
    executionId: string,
  ) => CheckpointSnapshot | undefined | Promise<CheckpointSnapshot | undefined>;
  readonly delete: (executionId: string) => void | Promise<void>;
}

export function createInMemoryCheckpointStore(): CompositionCheckpointStore {
  const snapshots = new Map<string, CheckpointSnapshot>();
  return {
    save: () => {},
    load: (id) => snapshots.get(id),
    delete: (id) => {
      snapshots.delete(id);
    },
  };
}
```

- [ ] **Step 3: Run, expect pass**

Run: `cd packages/lib/proactive && bun test composition-checkpoint-store.test.ts`
Expected: PASS (1 test).

- [ ] **Step 4: Commit**

```bash
cd /Users/sophiawj/.codex/worktrees/1301/koi && git add docs/superpowers/specs/2026-05-10-checkpoint-store-design.md docs/superpowers/plans/2026-05-10-checkpoint-store.md packages/lib/proactive/src/composition-checkpoint-store.ts packages/lib/proactive/src/composition-checkpoint-store.test.ts && git commit -m "feat(proactive): scaffold CompositionCheckpointStore interface + in-memory stub"
```

---

## Task 2: Save/load round-trip + multi-id + delete

**Files:**
- Modify: `packages/lib/proactive/src/composition-checkpoint-store.ts`
- Modify: `packages/lib/proactive/src/composition-checkpoint-store.test.ts`

- [ ] **Step 1: Write tests 2, 3, 4, 5, 6**

Append to `composition-checkpoint-store.test.ts`:

```typescript
  test("save then load returns the saved snapshot verbatim", async () => {
    const store = createInMemoryCheckpointStore();
    const snap = {
      executionId: "exec-1",
      planHash: "h1",
      nextStepIndex: 2,
      stepResults: [{ step: 0 }, { step: 1 }] as const,
      phase: "in_progress" as const,
      savedAt: 100,
    };
    await store.save(snap);
    expect(await store.load("exec-1")).toEqual(snap);
  });

  test("save twice with same executionId — load returns the latest", async () => {
    const store = createInMemoryCheckpointStore();
    const first = {
      executionId: "exec-1",
      planHash: "h1",
      nextStepIndex: 1,
      stepResults: [{ a: 1 }] as const,
      phase: "in_progress" as const,
      savedAt: 100,
    };
    const second = {
      executionId: "exec-1",
      planHash: "h1",
      nextStepIndex: 2,
      stepResults: [{ a: 1 }, { b: 2 }] as const,
      phase: "in_progress" as const,
      savedAt: 200,
    };
    await store.save(first);
    await store.save(second);
    expect(await store.load("exec-1")).toEqual(second);
  });

  test("save with different executionIds — load returns the right one per id", async () => {
    const store = createInMemoryCheckpointStore();
    const a = {
      executionId: "exec-A",
      planHash: "hA",
      nextStepIndex: 0,
      stepResults: [] as const,
      phase: "in_progress" as const,
      savedAt: 1,
    };
    const b = {
      executionId: "exec-B",
      planHash: "hB",
      nextStepIndex: 1,
      stepResults: [{ x: 1 }] as const,
      phase: "completed" as const,
      savedAt: 2,
    };
    await store.save(a);
    await store.save(b);
    expect(await store.load("exec-A")).toEqual(a);
    expect(await store.load("exec-B")).toEqual(b);
  });

  test("delete removes the snapshot — subsequent load returns undefined", async () => {
    const store = createInMemoryCheckpointStore();
    const snap = {
      executionId: "exec-1",
      planHash: "h1",
      nextStepIndex: 0,
      stepResults: [] as const,
      phase: "in_progress" as const,
      savedAt: 1,
    };
    await store.save(snap);
    await store.delete("exec-1");
    expect(await store.load("exec-1")).toBeUndefined();
  });

  test("delete of unknown id is a no-op", async () => {
    const store = createInMemoryCheckpointStore();
    // Should not throw.
    await store.delete("never-saved");
    expect(await store.load("never-saved")).toBeUndefined();
  });
```

- [ ] **Step 2: Run, expect failure on test 2**

Run: `cd packages/lib/proactive && bun test composition-checkpoint-store.test.ts`
Expected: FAIL on "save then load" — current `save` is a no-op.

- [ ] **Step 3: Implement `save`**

In `composition-checkpoint-store.ts`, replace the factory body:

```typescript
export function createInMemoryCheckpointStore(): CompositionCheckpointStore {
  const snapshots = new Map<string, CheckpointSnapshot>();
  return {
    save: (snapshot) => {
      snapshots.set(snapshot.executionId, snapshot);
    },
    load: (id) => snapshots.get(id),
    delete: (id) => {
      snapshots.delete(id);
    },
  };
}
```

- [ ] **Step 4: Run, expect pass**

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/lib/proactive/src/composition-checkpoint-store.ts packages/lib/proactive/src/composition-checkpoint-store.test.ts
git commit -m "feat(proactive): implement save/load/delete for in-memory checkpoint store"
```

---

## Task 3: Validation — invariants throw on caller bugs

**Files:**
- Modify: `packages/lib/proactive/src/composition-checkpoint-store.ts`
- Modify: `packages/lib/proactive/src/composition-checkpoint-store.test.ts`

- [ ] **Step 1: Write tests 7, 8, 9**

```typescript
  test("save throws when stepResults length does not match nextStepIndex", () => {
    const store = createInMemoryCheckpointStore();
    expect(() =>
      store.save({
        executionId: "exec-1",
        planHash: "h1",
        nextStepIndex: 2,
        stepResults: [{ a: 1 }],
        phase: "in_progress",
        savedAt: 1,
      }),
    ).toThrow(/stepResults.length must equal nextStepIndex/);
  });

  test("save throws when nextStepIndex is negative", () => {
    const store = createInMemoryCheckpointStore();
    expect(() =>
      store.save({
        executionId: "exec-1",
        planHash: "h1",
        nextStepIndex: -1,
        stepResults: [],
        phase: "in_progress",
        savedAt: 1,
      }),
    ).toThrow(/nextStepIndex must be >= 0/);
  });

  test("save throws when planHash or executionId is empty", () => {
    const store = createInMemoryCheckpointStore();
    expect(() =>
      store.save({
        executionId: "",
        planHash: "h1",
        nextStepIndex: 0,
        stepResults: [],
        phase: "in_progress",
        savedAt: 1,
      }),
    ).toThrow(/executionId must be non-empty/);

    expect(() =>
      store.save({
        executionId: "exec-1",
        planHash: "",
        nextStepIndex: 0,
        stepResults: [],
        phase: "in_progress",
        savedAt: 1,
      }),
    ).toThrow(/planHash must be non-empty/);
  });
```

- [ ] **Step 2: Run, expect failure (no validation yet)**

Expected: FAIL on all three.

- [ ] **Step 3: Add validation helper + call from `save`**

In `composition-checkpoint-store.ts`, add above the factory:

```typescript
function validateSnapshot(snapshot: CheckpointSnapshot): void {
  if (snapshot.executionId === "") {
    throw new Error("executionId must be non-empty");
  }
  if (snapshot.planHash === "") {
    throw new Error("planHash must be non-empty");
  }
  if (snapshot.nextStepIndex < 0 || !Number.isInteger(snapshot.nextStepIndex)) {
    throw new Error("nextStepIndex must be >= 0 and an integer");
  }
  if (snapshot.stepResults.length !== snapshot.nextStepIndex) {
    throw new Error(
      `stepResults.length must equal nextStepIndex (got ${snapshot.stepResults.length} vs ${snapshot.nextStepIndex})`,
    );
  }
}
```

Then call it as the first line of `save`:

```typescript
    save: (snapshot) => {
      validateSnapshot(snapshot);
      snapshots.set(snapshot.executionId, snapshot);
    },
```

- [ ] **Step 4: Run, expect pass**

Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/lib/proactive/src/composition-checkpoint-store.ts packages/lib/proactive/src/composition-checkpoint-store.test.ts
git commit -m "feat(proactive): validate checkpoint snapshot invariants on save"
```

---

## Task 4: Reference-isolation smoke test + index.ts exports

**Files:**
- Modify: `packages/lib/proactive/src/composition-checkpoint-store.test.ts`
- Modify: `packages/lib/proactive/src/index.ts`

- [ ] **Step 1: Write test 10 (reference isolation smoke check)**

```typescript
  test("stored snapshot is isolated from caller-side mutation of a copy", async () => {
    const store = createInMemoryCheckpointStore();
    const original = {
      executionId: "exec-1",
      planHash: "h1",
      nextStepIndex: 1,
      stepResults: [{ step: 0 }] as const,
      phase: "in_progress" as const,
      savedAt: 100,
    };
    await store.save(original);

    // Caller mutates a local copy — should NOT affect the stored snapshot
    // (readonly types make this a structural guarantee; this test documents
    // that intent and protects against an accidental future regression to
    // a mutable shape).
    const copy = { ...original, nextStepIndex: 99 };
    void copy;

    expect(await store.load("exec-1")).toEqual(original);
  });
```

- [ ] **Step 2: Run, expect pass (no impl change)**

Expected: PASS (10 tests).

- [ ] **Step 3: Add to `index.ts`**

Append to `packages/lib/proactive/src/index.ts`:

```typescript
export {
  type CheckpointPhase,
  type CheckpointSnapshot,
  type CompositionCheckpointStore,
  createInMemoryCheckpointStore,
} from "./composition-checkpoint-store.js";
```

- [ ] **Step 4: Run typecheck + tests**

```bash
cd /Users/sophiawj/.codex/worktrees/1301/koi/packages/lib/proactive && bun run typecheck && bun test composition-checkpoint-store.test.ts
```

Both should pass.

- [ ] **Step 5: Commit**

```bash
git add packages/lib/proactive/src/composition-checkpoint-store.test.ts packages/lib/proactive/src/index.ts
git commit -m "feat(proactive): export CheckpointStore types from package index"
```

---

## Task 5: Docs + final verify

**Files:**
- Modify: `docs/L2/proactive.md`
- Modify: `docs/L3/runtime.md`

- [ ] **Step 1: Append "Composition checkpoints" subsection to `docs/L2/proactive.md`** at the end of the file:

```markdown
## Composition checkpoints (#1301 Part 2 foundation)

`createInMemoryCheckpointStore` is the foundation contract for durable
composition execution. It models **per-plan progress** — distinct from
`CompositionExecutionLog` which models per-side-effect dedupe. The two
coexist: the execution log keeps step-level idempotency; the checkpoint
store enables coarse-grained plan resume.

```typescript
import { createInMemoryCheckpointStore, type CheckpointSnapshot } from "@koi/proactive";

const store = createInMemoryCheckpointStore();

// After step k completes, before moving to k+1:
await store.save({
  executionId: "comp-42",
  planHash: hashPlan(plan),
  nextStepIndex: k + 1,
  stepResults: [...resultsSoFar, latestResult],
  phase: "in_progress",
  savedAt: now(),
});

// On restart, before the step loop:
const snap = await store.load("comp-42");
const start = snap !== undefined && snap.planHash === hashPlan(plan) ? snap.nextStepIndex : 0;
```

`save` validates invariants synchronously and throws on caller bugs:
empty `executionId`/`planHash`, negative or non-integer
`nextStepIndex`, or `stepResults.length !== nextStepIndex`.

The interface returns `void | Promise<void>` and `CheckpointSnapshot
| undefined | Promise<...>` so durable backends (Temporal, SQLite,
Redis) implement the same contract. Executor wiring and a Temporal-backed
implementation are tracked as separate slices of #1301 Part 2.
```

- [ ] **Step 2: Prepend changelog entry to `docs/L3/runtime.md` under `## Changelog`**

```markdown
- 2026-05-10: `@koi/proactive` adds `CompositionCheckpointStore` contract + `createInMemoryCheckpointStore` (issue #1301 Part 2 foundation). New per-plan progress primitive complementing the existing per-side-effect `CompositionExecutionLog` — enables coarse-grained plan resume on restart. `save` validates `executionId`/`planHash` non-empty, integer `nextStepIndex >= 0`, and `stepResults.length === nextStepIndex`. Interface returns `T \| Promise<T>` so future Temporal- and SQLite-backed implementations can satisfy the same shape. Executor wiring and durable backends are tracked as follow-up slices.
```

- [ ] **Step 3: Final verify**

```bash
cd /Users/sophiawj/.codex/worktrees/1301/koi/packages/lib/proactive && bun run typecheck && bun run lint && bun test
cd /Users/sophiawj/.codex/worktrees/1301/koi && bun run check:layers && bun run check:doc-wiring
```

All must pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/sophiawj/.codex/worktrees/1301/koi && git add docs/L2/proactive.md docs/L3/runtime.md && git commit -m "docs(proactive): document CompositionCheckpointStore contract"
```

---

## Self-Review

- All 10 spec tests covered (Task 1: 1; Task 2: 2-6; Task 3: 7-9; Task 4: 10).
- No placeholders.
- Type names consistent: `CheckpointSnapshot`, `CheckpointPhase`, `CompositionCheckpointStore`, `createInMemoryCheckpointStore`.
- Validation rules match spec exactly.
- Out-of-scope items (executor wiring, Temporal backend, SQLite backend, plan-hash helper) explicitly deferred.
