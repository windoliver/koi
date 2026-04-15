import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryRecordId } from "@koi/core";
import { createLocalFileSystem } from "@koi/fs-local";
import { recallMemories } from "@koi/memory";
import { createMemoryStore } from "@koi/memory-fs";
import type { MemoryToolBackend } from "@koi/memory-tools";
import { createMemoryToolBackendFromStore } from "./memory-adapter.js";

describe("memory-adapter E2E", () => {
  let dir: string;
  let backend: MemoryToolBackend;

  beforeEach(async () => {
    // Use realpath to resolve macOS /var -> /private/var symlink so
    // createLocalFileSystem's root matches the paths passed to recallMemories.
    dir = await realpath(await mkdtemp(join(tmpdir(), "koi-memory-adapter-test-")));
    const store = createMemoryStore({ dir });
    backend = createMemoryToolBackendFromStore(store);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("adapter store writes to disk and recall reads it back", async () => {
    const result = await backend.storeWithDedup(
      { name: "test", description: "test desc", type: "user", content: "test content" },
      { force: false },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.action).toBe("created");

    const fs = createLocalFileSystem(dir);
    const recall = await recallMemories(fs, { memoryDir: dir });

    expect(recall.selected.length).toBe(1);
    expect(recall.selected[0]?.memory.record.name).toBe("test");
    expect(recall.formatted).toContain("test content");
  });

  test("adapter storeWithDedup detects name+type conflict", async () => {
    const first = await backend.storeWithDedup(
      { name: "pref", description: "preference desc", type: "user", content: "preference value" },
      { force: false },
    );
    expect(first.ok).toBe(true);

    const second = await backend.storeWithDedup(
      { name: "pref", description: "updated desc", type: "user", content: "new content" },
      { force: false },
    );

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.action).toBe("conflict");
  });

  test("adapter storeWithDedup force-updates existing", async () => {
    const first = await backend.storeWithDedup(
      { name: "setting", description: "a setting", type: "feedback", content: "original value" },
      { force: false },
    );
    expect(first.ok).toBe(true);

    const second = await backend.storeWithDedup(
      { name: "setting", description: "a setting", type: "feedback", content: "updated value" },
      { force: true },
    );

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.action).toBe("updated");

    const fs = createLocalFileSystem(dir);
    const recall = await recallMemories(fs, { memoryDir: dir });

    expect(recall.selected.length).toBe(1);
    expect(recall.formatted).toContain("updated value");
    expect(recall.formatted).not.toContain("original value");
  });

  test("adapter search filters by keyword", async () => {
    await backend.storeWithDedup(
      { name: "alpha", description: "first", type: "user", content: "apples are red" },
      { force: false },
    );
    await backend.storeWithDedup(
      { name: "beta", description: "second", type: "feedback", content: "bananas are yellow" },
      { force: false },
    );
    await backend.storeWithDedup(
      { name: "gamma", description: "third", type: "reference", content: "grapes are purple" },
      { force: false },
    );

    const result = await backend.search({ keyword: "banana" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBe(1);
    expect(result.value[0]?.name).toBe("beta");
  });

  test("adapter delete removes record from disk", async () => {
    const storeResult = await backend.storeWithDedup(
      { name: "ephemeral", description: "temp", type: "project", content: "temporary data" },
      { force: false },
    );

    expect(storeResult.ok).toBe(true);
    if (!storeResult.ok) return;
    expect(storeResult.value.action).toBe("created");
    if (storeResult.value.action !== "created") return;

    const recordId: MemoryRecordId = storeResult.value.record.id;

    const deleteResult = await backend.delete(recordId);
    expect(deleteResult.ok).toBe(true);
    if (!deleteResult.ok) return;
    expect(deleteResult.value.wasPresent).toBe(true);

    const fs = createLocalFileSystem(dir);
    const recall = await recallMemories(fs, { memoryDir: dir });

    expect(recall.selected.length).toBe(0);
    expect(recall.formatted).toBe("");
  });
});
