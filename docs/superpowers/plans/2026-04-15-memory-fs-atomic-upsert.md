# Atomic (name, type) Upsert in MemoryStore — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an atomic `upsert()` method to `MemoryStore` that runs name+type lookup, Jaccard dedup, and create/update inside a single `withDirLock()` critical section, eliminating the cross-process TOCTOU race in `storeWithDedup`.

**Architecture:** New `upsert()` method on `MemoryStore` reuses existing internal functions (`scanRecords`, `findDuplicate`, `writeExclusive`, `updateRecord`) inside the dir lock. Adapter's `storeWithDedup` collapses to a single `store.upsert()` call, removing the in-process `dedupChain` mutex.

**Tech Stack:** Bun 1.3.x, bun:test, TypeScript 6 strict

**Spec:** `docs/superpowers/specs/2026-04-15-memory-fs-atomic-upsert-design.md`

---

### Task 1: Add `UpsertResult` type and `upsert` to `MemoryStore` interface

**Files:**
- Modify: `packages/mm/memory-fs/src/types.ts:22,40-53,98-110`
- Modify: `packages/mm/memory-fs/src/index.ts:21-31`

- [ ] **Step 1: Add `UpsertResult` type to `types.ts`**

After the existing `DeleteResult` interface (line 67), add:

```typescript
/** Result of an atomic upsert (name+type lookup + Jaccard dedup + write/update). */
export type UpsertResult =
  | { readonly action: "created"; readonly record: MemoryRecord; readonly indexError?: unknown }
  | { readonly action: "updated"; readonly record: MemoryRecord; readonly indexError?: unknown }
  | {
      readonly action: "conflict";
      readonly existing: MemoryRecord;
      readonly indexError?: unknown;
    }
  | {
      readonly action: "skipped";
      readonly record: MemoryRecord;
      readonly duplicateOf: MemoryRecordId;
      readonly similarity: number;
      readonly indexError?: unknown;
    };
```

- [ ] **Step 2: Add `"upsert"` to `MemoryStoreOperation`**

Change line 22 from:
```typescript
export type MemoryStoreOperation = "write" | "update" | "delete" | "rebuild";
```
to:
```typescript
export type MemoryStoreOperation = "write" | "update" | "upsert" | "delete" | "rebuild";
```

- [ ] **Step 3: Add `upsert` method to `MemoryStore` interface**

After `rebuildIndex` (line 109), add:

```typescript
  /**
   * Atomic name+type upsert — runs the full check+write inside the
   * per-directory lock.
   *
   * Flow (all inside `withDirLock()`):
   * 1. Scan existing records.
   * 2. Name+type match → conflict (force=false) or update (force=true).
   * 3. Jaccard content dedup → skip if similar record exists.
   * 4. Write new record.
   */
  readonly upsert: (
    input: MemoryRecordInput,
    opts: { readonly force: boolean },
  ) => Promise<UpsertResult>;
```

- [ ] **Step 4: Export `UpsertResult` from `index.ts`**

Add `UpsertResult` to the type export block in `index.ts`:

```typescript
export type {
  DedupResult,
  DeleteResult,
  IndexErrorCallback,
  MemoryListFilter,
  MemoryStore,
  MemoryStoreConfig,
  MemoryStoreOperation,
  UpdateResult,
  UpsertResult,
} from "./types.js";
```

- [ ] **Step 5: Verify typecheck passes**

Run: `bun run typecheck --filter=@koi/memory-fs`

Expected: Type error — `createMemoryStore` does not return an object satisfying `MemoryStore` (missing `upsert`). This is expected; Task 2 implements it.

- [ ] **Step 6: Commit**

```bash
git add packages/mm/memory-fs/src/types.ts packages/mm/memory-fs/src/index.ts
git commit -m "feat(memory-fs): add UpsertResult type and upsert to MemoryStore interface

Ref #1824"
```

---

### Task 2: Implement `upsert()` in `createMemoryStore`

**Files:**
- Modify: `packages/mm/memory-fs/src/store.ts:44-53,102-141`

- [ ] **Step 1: Add `UpsertResult` to the import from `./types.js`**

Change the import block (lines 44-54) to include `UpsertResult`:

```typescript
import type {
  DedupResult,
  DeleteResult,
  IndexErrorCallback,
  MemoryListFilter,
  MemoryStore,
  MemoryStoreConfig,
  MemoryStoreOperation,
  UpdateResult,
  UpsertResult,
} from "./types.js";
import { DEFAULT_DEDUP_THRESHOLD } from "./types.js";
```

- [ ] **Step 2: Add `upsertRecord` internal function**

After `deleteRecord` (after line 301), add:

```typescript
async function upsertRecord(
  ctx: StoreContext,
  input: MemoryRecordInput,
  force: boolean,
): Promise<UpsertResult> {
  const { dir, threshold } = ctx;
  const existing = await scanRecords(dir);

  // Step 1: Name+type exact match
  const nameTypeMatch = existing.find(
    (r) => r.name === input.name && r.type === input.type,
  );

  if (nameTypeMatch !== undefined) {
    if (!force) {
      return { action: "conflict", existing: nameTypeMatch };
    }
    // Force update — overwrite the matched record's description + content.
    const updated = await updateRecord(ctx, nameTypeMatch.id, {
      description: input.description,
      content: input.content,
    });
    return { action: "updated", record: updated.record };
  }

  // Step 2: Jaccard content dedup (no name+type match found)
  const dup = findDuplicate(input.content, existing, threshold);
  if (dup !== undefined) {
    return {
      action: "skipped",
      record: dup.record,
      duplicateOf: dup.id,
      similarity: dup.similarity,
    };
  }

  // Step 3: Create new record
  const serialized = serializeMemoryFrontmatter(
    { name: input.name, description: input.description, type: input.type },
    input.content,
  );
  if (serialized === undefined) {
    throw new Error("Failed to serialize memory record — invalid frontmatter or empty content");
  }

  const filename = await writeExclusive(dir, input.name, serialized);
  const fileStat = await stat(join(dir, filename));

  const persisted = parseMemoryFrontmatter(serialized);
  const record: MemoryRecord = {
    id: memoryRecordId(filenameToId(filename)),
    name: persisted?.frontmatter.name ?? input.name,
    description: persisted?.frontmatter.description ?? input.description,
    type: persisted?.frontmatter.type ?? input.type,
    content: persisted?.content ?? input.content,
    filePath: filename,
    createdAt: Math.min(fileStat.birthtimeMs, fileStat.mtimeMs),
    updatedAt: fileStat.ctimeMs,
  };

  return { action: "created", record };
}
```

- [ ] **Step 3: Add `upsert` to the returned store object**

After the `rebuildIndex` method in the returned object (after line 141), add:

```typescript
    upsert: async (input, opts) => {
      const errors = validateMemoryRecordInput({ ...input });
      if (errors.length > 0) {
        const messages = errors.map((e) => `${e.field}: ${e.message}`).join("; ");
        throw new Error(`Invalid memory record input: ${messages}`);
      }
      const ctx = await getContext();
      const res = await withDirLock(ctx.canonicalDir, () =>
        upsertRecord(ctx, input, opts.force),
      );
      // Index rebuild for any action that mutated disk (created or updated).
      if (res.action === "created" || res.action === "updated") {
        const indexError = await chainedRebuild(ctx, "upsert");
        return indexError === undefined ? res : { ...res, indexError };
      }
      return res;
    },
```

- [ ] **Step 4: Verify typecheck passes**

Run: `bun run typecheck --filter=@koi/memory-fs`

Expected: PASS — `createMemoryStore` now satisfies the `MemoryStore` interface including `upsert`.

- [ ] **Step 5: Commit**

```bash
git add packages/mm/memory-fs/src/store.ts
git commit -m "feat(memory-fs): implement upsert() under withDirLock

Atomic name+type lookup + Jaccard dedup + write/update inside the
per-directory critical section. Ref #1824"
```

---

### Task 3: Unit tests for `upsert()` — all 4 result variants

**Files:**
- Modify: `packages/mm/memory-fs/src/store.test.ts`

- [ ] **Step 1: Add upsert describe block after the existing `"validation"` block (line 362)**

```typescript
  describe("upsert", () => {
    test("creates new record when no name+type match and no Jaccard match", async () => {
      const dir = makeDir();
      const store = createMemoryStore({ dir });

      const result = await store.upsert(
        {
          name: "New Memory",
          description: "A brand new memory",
          type: "user",
          content: "Completely unique content for the new memory record.",
        },
        { force: false },
      );

      expect(result.action).toBe("created");
      if (result.action !== "created") return;
      expect(result.record.name).toBe("New Memory");
      expect(result.record.type).toBe("user");
      expect(result.indexError).toBeUndefined();

      const all = await store.list();
      expect(all.length).toBe(1);
    });

    test("returns conflict when name+type match exists and force=false", async () => {
      const dir = makeDir();
      const store = createMemoryStore({ dir });

      await store.upsert(
        {
          name: "Existing",
          description: "Original desc",
          type: "feedback",
          content: "Original feedback content.",
        },
        { force: false },
      );

      const result = await store.upsert(
        {
          name: "Existing",
          description: "Updated desc",
          type: "feedback",
          content: "Completely different content for the same name and type.",
        },
        { force: false },
      );

      expect(result.action).toBe("conflict");
      if (result.action !== "conflict") return;
      expect(result.existing.name).toBe("Existing");
      expect(result.existing.content).toBe("Original feedback content.");

      const all = await store.list();
      expect(all.length).toBe(1);
    });

    test("updates in place when name+type match exists and force=true", async () => {
      const dir = makeDir();
      const store = createMemoryStore({ dir });

      const first = await store.upsert(
        {
          name: "Overwrite Me",
          description: "Will be overwritten",
          type: "project",
          content: "Initial project content to be overwritten.",
        },
        { force: false },
      );
      expect(first.action).toBe("created");

      const second = await store.upsert(
        {
          name: "Overwrite Me",
          description: "Overwritten desc",
          type: "project",
          content: "Updated project content after force upsert.",
        },
        { force: true },
      );

      expect(second.action).toBe("updated");
      if (second.action !== "updated") return;
      expect(second.record.content).toBe("Updated project content after force upsert.");
      expect(second.record.description).toBe("Overwritten desc");
      expect(second.indexError).toBeUndefined();

      const all = await store.list();
      expect(all.length).toBe(1);
      expect(all[0]?.content).toBe("Updated project content after force upsert.");
    });

    test("skips when no name+type match but Jaccard content is similar", async () => {
      const dir = makeDir();
      const store = createMemoryStore({ dir, dedupThreshold: 0.7 });

      const first = await store.upsert(
        {
          name: "Alpha",
          description: "First memory",
          type: "user",
          content: "The user prefers dark mode in all editors and terminals.",
        },
        { force: false },
      );
      expect(first.action).toBe("created");

      const second = await store.upsert(
        {
          name: "Beta",
          description: "Different name",
          type: "feedback",
          content: "The user prefers dark mode in all editors and terminals.",
        },
        { force: false },
      );

      expect(second.action).toBe("skipped");
      if (second.action !== "skipped") return;
      if (first.action !== "created") return;
      expect(second.duplicateOf).toBe(first.record.id);
      expect(second.similarity).toBe(1);
    });

    test("name+type match takes precedence over Jaccard (different name, same content)", async () => {
      const dir = makeDir();
      const store = createMemoryStore({ dir, dedupThreshold: 0.7 });

      // Write a record via write() — different name but identical content
      await store.write({
        name: "Jaccard Bait",
        description: "Has matching content",
        type: "reference",
        content: "Shared content that would trigger Jaccard dedup normally.",
      });

      // Write another record with the same name+type we will upsert
      await store.upsert(
        {
          name: "Target",
          description: "Name match target",
          type: "user",
          content: "Different unique content for the target record.",
        },
        { force: false },
      );

      // Upsert with name+type matching "Target/user" — should conflict on
      // name+type, NOT skip on Jaccard against "Jaccard Bait"
      const result = await store.upsert(
        {
          name: "Target",
          description: "Updated target",
          type: "user",
          content: "Shared content that would trigger Jaccard dedup normally.",
        },
        { force: false },
      );

      expect(result.action).toBe("conflict");
      if (result.action !== "conflict") return;
      expect(result.existing.name).toBe("Target");
    });

    test("validates input before any filesystem side effect", async () => {
      const dir = makeDir();
      const store = createMemoryStore({ dir });

      await expect(
        store.upsert(
          { name: "", description: "bad", type: "user", content: "content" },
          { force: false },
        ),
      ).rejects.toThrow("Invalid memory record input");
    });
  });
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `bun test packages/mm/memory-fs/src/store.test.ts`

Expected: All existing tests PASS, all 6 new upsert tests PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/mm/memory-fs/src/store.test.ts
git commit -m "test(memory-fs): unit tests for upsert() — all 4 result variants

Covers created, conflict, updated, skipped, precedence, and validation.
Ref #1824"
```

---

### Task 4: In-process concurrency test for `upsert()`

**Files:**
- Modify: `packages/mm/memory-fs/src/concurrency.test.ts`

- [ ] **Step 1: Add upsert concurrency tests after the existing `"write critical section"` describe block**

Before the `"file-lock stale ownership"` describe block (line 228), add:

```typescript
describe("upsert critical section", () => {
  test("10 concurrent upserts same (name,type) force=false → 1 created, 9 conflict", async () => {
    const dir = makeDir("upsert-conflict");
    const store = createMemoryStore({ dir });

    const input = {
      name: "Race Target",
      description: "Concurrent upsert target",
      type: "user" as const,
      content: "Content for concurrent upsert race test, unique enough to avoid Jaccard.",
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.upsert(input, { force: false })),
    );

    const created = results.filter((r) => r.action === "created");
    const conflicts = results.filter((r) => r.action === "conflict");
    expect(created.length).toBe(1);
    expect(conflicts.length).toBe(9);

    const all = await store.list();
    expect(all.length).toBe(1);
  });

  test("10 concurrent upserts same (name,type) force=true → all updated, 1 file", async () => {
    const dir = makeDir("upsert-force");
    const store = createMemoryStore({ dir });

    // Seed the record so all upserts find a name+type match.
    await store.upsert(
      {
        name: "Force Target",
        description: "Will be overwritten",
        type: "project" as const,
        content: "Seed content for the force upsert concurrency test.",
      },
      { force: false },
    );

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.upsert(
          {
            name: "Force Target",
            description: `Overwrite ${String(i)}`,
            type: "project" as const,
            content: `Force update content iteration ${String(i)} with padding words.`,
          },
          { force: true },
        ),
      ),
    );

    expect(results.every((r) => r.action === "updated")).toBe(true);

    const all = await store.list();
    expect(all.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run concurrency tests**

Run: `bun test packages/mm/memory-fs/src/concurrency.test.ts`

Expected: All existing + new tests PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/mm/memory-fs/src/concurrency.test.ts
git commit -m "test(memory-fs): in-process concurrency tests for upsert()

10 concurrent same (name,type) with force=false and force=true.
Ref #1824"
```

---

### Task 5: Cross-process concurrency test

**Files:**
- Create: `packages/mm/memory-fs/src/__tests__/cross-process-worker.ts`
- Create: `packages/mm/memory-fs/src/cross-process.test.ts`

- [ ] **Step 1: Create the `__tests__` directory**

Run: `mkdir -p packages/mm/memory-fs/src/__tests__`

- [ ] **Step 2: Write the worker script**

Create `packages/mm/memory-fs/src/__tests__/cross-process-worker.ts`:

```typescript
/**
 * Child-process worker for cross-process upsert tests.
 *
 * Usage: bun run <this-file> <dir> <name> <type> <force>
 *
 * Waits for the go-signal file to be removed, then calls store.upsert()
 * and writes the result action to stdout as JSON.
 */

import { stat } from "node:fs/promises";
import { createMemoryStore } from "../store.js";

const [dir, name, type, forceStr, goSignal] = process.argv.slice(2);

if (!dir || !name || !type || !forceStr || !goSignal) {
  process.stderr.write("Usage: bun run worker.ts <dir> <name> <type> <force> <goSignal>\n");
  process.exit(1);
}

const force = forceStr === "true";

// Spin-wait for the go signal file to disappear (parent removes it).
const waitForGo = async (): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    try {
      await stat(goSignal);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch {
      return;
    }
  }
  throw new Error("Timed out waiting for go signal");
};

const run = async (): Promise<void> => {
  const store = createMemoryStore({ dir });
  await waitForGo();

  const result = await store.upsert(
    {
      name,
      description: `Cross-process test record ${name}`,
      type: type as "user",
      content: `Content from child process for ${name} record in cross-process test.`,
    },
    { force },
  );

  process.stdout.write(JSON.stringify({ action: result.action }) + "\n");
};

run().catch((e: unknown) => {
  process.stderr.write(String(e) + "\n");
  process.exit(1);
});
```

- [ ] **Step 3: Write the cross-process test file**

Create `packages/mm/memory-fs/src/cross-process.test.ts`:

```typescript
/**
 * Cross-process concurrency tests for MemoryStore.upsert().
 *
 * Spawns real child processes via Bun.spawn to verify that the file lock
 * serializes the full check+write across process boundaries.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore } from "./store.js";

const TEST_ROOT = join(tmpdir(), "koi-memfs-cross-process");
const WORKER_PATH = join(import.meta.dir, "__tests__", "cross-process-worker.ts");

afterEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

function makeDir(label: string): string {
  const id = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(TEST_ROOT, id);
}

interface WorkerResult {
  readonly action: string;
}

async function spawnWorker(
  dir: string,
  name: string,
  type: string,
  force: boolean,
  goSignal: string,
): Promise<WorkerResult> {
  const proc = Bun.spawn(
    ["bun", "run", WORKER_PATH, dir, name, type, String(force), goSignal],
    { stdout: "pipe", stderr: "pipe" },
  );

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if (exitCode !== 0) {
    throw new Error(`Worker exited ${String(exitCode)}: ${stderr}`);
  }

  return JSON.parse(stdout.trim()) as WorkerResult;
}

describe("cross-process upsert", () => {
  test("two processes, same (name,type), force=false → one created, one conflict", async () => {
    const dir = makeDir("xproc-conflict");
    await mkdir(dir, { recursive: true });
    const goSignal = join(dir, ".go-signal");
    await writeFile(goSignal, "wait", "utf-8");

    // Spawn two child workers — both will spin-wait on the go signal.
    const p1 = spawnWorker(dir, "shared", "user", false, goSignal);
    const p2 = spawnWorker(dir, "shared", "user", false, goSignal);

    // Brief delay to let both workers start spinning.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Remove the go signal — both workers race to upsert.
    await unlink(goSignal);

    const [r1, r2] = await Promise.all([p1, p2]);
    const actions = [r1.action, r2.action].sort();

    expect(actions).toEqual(["conflict", "created"]);

    // Verify exactly one file on disk.
    const store = createMemoryStore({ dir });
    const all = await store.list();
    expect(all.length).toBe(1);
    expect(all[0]?.name).toBe("shared");
  }, 15_000);

  test("two processes, same (name,type), force=true → both updated, one file", async () => {
    const dir = makeDir("xproc-force");
    await mkdir(dir, { recursive: true });

    // Seed the record before spawning workers.
    const store = createMemoryStore({ dir });
    await store.upsert(
      {
        name: "force-target",
        description: "Seed",
        type: "project",
        content: "Seed content for cross-process force test record.",
      },
      { force: false },
    );

    const goSignal = join(dir, ".go-signal");
    await writeFile(goSignal, "wait", "utf-8");

    const p1 = spawnWorker(dir, "force-target", "project", true, goSignal);
    const p2 = spawnWorker(dir, "force-target", "project", true, goSignal);

    await new Promise((resolve) => setTimeout(resolve, 100));
    await unlink(goSignal);

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.action).toBe("updated");
    expect(r2.action).toBe("updated");

    const all = await store.list();
    expect(all.length).toBe(1);
  }, 15_000);

  test("two processes, different (name,type) → both created, two files", async () => {
    const dir = makeDir("xproc-distinct");
    await mkdir(dir, { recursive: true });
    const goSignal = join(dir, ".go-signal");
    await writeFile(goSignal, "wait", "utf-8");

    const p1 = spawnWorker(dir, "record-alpha", "user", false, goSignal);
    const p2 = spawnWorker(dir, "record-beta", "feedback", false, goSignal);

    await new Promise((resolve) => setTimeout(resolve, 100));
    await unlink(goSignal);

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.action).toBe("created");
    expect(r2.action).toBe("created");

    const store = createMemoryStore({ dir });
    const all = await store.list();
    expect(all.length).toBe(2);
  }, 15_000);
});
```

- [ ] **Step 4: Run cross-process tests**

Run: `bun test packages/mm/memory-fs/src/cross-process.test.ts`

Expected: All 3 tests PASS. The file lock serializes the two processes correctly.

- [ ] **Step 5: Commit**

```bash
git add packages/mm/memory-fs/src/__tests__/cross-process-worker.ts packages/mm/memory-fs/src/cross-process.test.ts
git commit -m "test(memory-fs): cross-process concurrency tests for upsert()

Spawns real child processes via Bun.spawn to verify the file lock
serializes name+type check+write across process boundaries.
Ref #1824"
```

---

### Task 6: Simplify adapter to delegate to `store.upsert()`

**Files:**
- Modify: `packages/meta/cli/src/preset-stacks/memory-adapter.ts:34-121`

- [ ] **Step 1: Remove the `dedupChain` and `withDedupLock` code (lines 34-55)**

Delete:
```typescript
// ---------------------------------------------------------------------------
// In-process serializer for storeWithDedup
// ---------------------------------------------------------------------------

/**
 * Serialize storeWithDedup calls so the name+type check and the
 * subsequent write/update happen without interleaving. Without this,
 * two concurrent calls with the same (name,type) could both observe
 * "no match" and both create a record.
 *
 * This is an in-process mutex only — cross-process atomicity relies on
 * MemoryStore's directory file lock. A proper fix would add an atomic
 * upsert API to MemoryStore itself.
 */
// let justified: serialization chain for storeWithDedup
let dedupChain: Promise<unknown> = Promise.resolve();

function withDedupLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = dedupChain.then(fn, fn);
  dedupChain = next.catch((): undefined => undefined);
  return next;
}
```

- [ ] **Step 2: Replace `storeWithDedup` body (lines 82-121)**

Replace the entire `storeWithDedup` method with:

```typescript
    storeWithDedup: async (input, opts) => {
      try {
        const result = await store.upsert(input, { force: opts.force });
        return ok(mapUpsertResult(result));
      } catch (e: unknown) {
        return fail(e);
      }
    },
```

- [ ] **Step 3: Add the `mapUpsertResult` helper function**

After the `fail` function (line 32), add:

```typescript
// ---------------------------------------------------------------------------
// UpsertResult → StoreWithDedupResult mapping
// ---------------------------------------------------------------------------

function mapUpsertResult(result: UpsertResult): StoreWithDedupResult {
  switch (result.action) {
    case "created":
      return { action: "created", record: result.record };
    case "updated":
      return { action: "updated", record: result.record };
    case "conflict":
      return { action: "conflict", existing: result.existing };
    case "skipped":
      return { action: "conflict", existing: result.record };
  }
}
```

- [ ] **Step 4: Add the `UpsertResult` import**

Update the import from `@koi/memory-fs` to include `UpsertResult`:

```typescript
import type { MemoryStore, UpsertResult } from "@koi/memory-fs";
```

- [ ] **Step 5: Verify typecheck passes**

Run: `bun run typecheck --filter=@koi/cli`

Expected: PASS.

- [ ] **Step 6: Run existing adapter tests**

Run: `bun test packages/meta/cli/src/preset-stacks/memory-adapter.test.ts`

Expected: All 5 existing tests PASS — the adapter delegates to `store.upsert()` and the behavior is identical.

- [ ] **Step 7: Commit**

```bash
git add packages/meta/cli/src/preset-stacks/memory-adapter.ts
git commit -m "refactor(memory-adapter): delegate storeWithDedup to store.upsert()

Removes the in-process dedupChain mutex. All atomicity now handled
by MemoryStore.upsert() under withDirLock(). Ref #1824"
```

---

### Task 7: Run full CI gate

**Files:** None — verification only.

- [ ] **Step 1: Run all memory-fs tests**

Run: `bun test packages/mm/memory-fs/`

Expected: All tests PASS (store, concurrency, cross-process).

- [ ] **Step 2: Run adapter tests**

Run: `bun test packages/meta/cli/src/preset-stacks/memory-adapter.test.ts`

Expected: All 5 tests PASS.

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`

Expected: PASS.

- [ ] **Step 4: Run lint**

Run: `bun run lint`

Expected: PASS.

- [ ] **Step 5: Run layer check**

Run: `bun run check:layers`

Expected: PASS — no L2-to-L2 imports introduced.

- [ ] **Step 6: Commit any autofix changes from lint (if any)**

```bash
git add -A && git commit -m "chore: lint autofix" || echo "Nothing to fix"
```
