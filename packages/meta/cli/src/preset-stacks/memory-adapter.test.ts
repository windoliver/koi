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

// ---------------------------------------------------------------------------
// Tool-level round-trip: memory_store execute → memory_recall execute (#1725)
// ---------------------------------------------------------------------------

describe("memory tool round-trip (#1725 regression)", () => {
  let dir: string;
  let backend: MemoryToolBackend;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "koi-memory-tool-roundtrip-")));
    const store = createMemoryStore({ dir });
    backend = createMemoryToolBackendFromStore(store);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("memory_recall returns stored data after memory_store", async () => {
    const { createMemoryStoreTool } = await import("@koi/memory-tools");
    const { createMemoryRecallTool } = await import("@koi/memory-tools");

    const storeResult = createMemoryStoreTool(backend, dir);
    const recallResult = createMemoryRecallTool(backend, dir);
    expect(storeResult.ok).toBe(true);
    expect(recallResult.ok).toBe(true);
    if (!storeResult.ok || !recallResult.ok) return;

    const storeTool = storeResult.value;
    const recallTool = recallResult.value;

    // Step 1: Store a memory
    const storeOutput = (await storeTool.execute({
      name: "project_toolchain",
      description: "Project uses Bun and Biome",
      type: "user",
      content: "This project uses Bun 1.3 and Biome for linting.",
    })) as Record<string, unknown>;

    expect(storeOutput.stored).toBe(true);
    expect(storeOutput.id).toBeDefined();

    // Step 2: Recall the memory — this is the path that fails in TUI (#1725)
    const recallOutput = (await recallTool.execute({
      query: "toolchain",
    })) as Record<string, unknown>;

    // Bug #1725: recall should return the stored memory, not an error
    expect(recallOutput.count).toBe(1);
    expect(recallOutput.results).toBeDefined();
    const results = recallOutput.results as readonly Record<string, unknown>[];
    expect(results[0]?.name).toBe("project_toolchain");
    expect(results[0]?.content).toContain("Bun 1.3");
  });

  test("memory_store output does not contain misleading filePath (#1725 bug 2)", async () => {
    const { createMemoryStoreTool } = await import("@koi/memory-tools");

    const storeResult = createMemoryStoreTool(backend, dir);
    expect(storeResult.ok).toBe(true);
    if (!storeResult.ok) return;

    const storeOutput = (await storeResult.value.execute({
      name: "test_memory",
      description: "test desc",
      type: "feedback",
      content: "test content",
    })) as Record<string, unknown>;

    expect(storeOutput.stored).toBe(true);
    // #1725: filePath must be absent — internal implementation detail
    // that leaked local filesystem paths to model output.
    expect("filePath" in storeOutput).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// File-backed adapter E2E
// ---------------------------------------------------------------------------

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

  test("adapter.store surfaces (name,type) conflict as a loud error (no silent data loss)", async () => {
    // First write succeeds normally.
    const first = await backend.store({
      name: "dup-name",
      description: "first",
      type: "feedback",
      content: "first payload content body, non-similar to the follow-up",
    });
    expect(first.ok).toBe(true);

    // Second write with the same (name, type) but different content must
    // NOT silently map to ok(existing). That mapping would cause concurrent
    // extraction-style writes (`extracted-${Date.now()}`) to drop payloads
    // if they happened to land on the same millisecond. Surface a loud
    // error so callers can retry with a fresh name instead.
    const second = await backend.store({
      name: "dup-name",
      description: "second",
      type: "feedback",
      content: "completely different follow-up payload with no Jaccard overlap",
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.message).toContain("Memory record already exists");

    // The on-disk state must still contain the first payload — only one
    // file, and its content is the first write's body.
    const all = await backend.recall("", undefined);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value.length).toBe(1);
    expect(all.value[0]?.content).toContain("first payload content body");
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

  test("adapter recall returns stored records (#1725 regression)", async () => {
    // Bug #1725: memory_recall fails in TUI after successful memory_store.
    // This test validates the adapter's recall path independently.
    await backend.storeWithDedup(
      {
        name: "toolchain",
        description: "project toolchain",
        type: "user",
        content: "Bun 1.3 and Biome",
      },
      { force: false },
    );

    const recallResult = await backend.recall("toolchain", undefined);

    expect(recallResult.ok).toBe(true);
    if (!recallResult.ok) return;
    expect(recallResult.value.length).toBe(1);
    expect(recallResult.value[0]?.name).toBe("toolchain");
    expect(recallResult.value[0]?.content).toBe("Bun 1.3 and Biome");
  });

  test("adapter recall returns empty array when no records exist (#1725)", async () => {
    const recallResult = await backend.recall("anything", undefined);

    expect(recallResult.ok).toBe(true);
    if (!recallResult.ok) return;
    expect(recallResult.value.length).toBe(0);
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
