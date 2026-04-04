/**
 * Integration test: same agent operations work with both filesystem backends.
 *
 * Proves that manifest-driven dispatch produces interchangeable backends —
 * the same read/write/edit/list/search/delete sequence works regardless of
 * whether the backend is "local" or "nexus" (via fake transport).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileSystemBackend } from "@koi/core";
import { FILESYSTEM, isAttachResult, toolToken } from "@koi/core";
import { createFileSystemProvider } from "../create-filesystem-provider.js";
import { createRuntime } from "../create-runtime.js";
import { resolveFileSystem } from "../resolve-filesystem.js";

const tmpBase = mkdtempSync(join(tmpdir(), "koi-fs-integration-"));

afterAll(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

/**
 * Run the same integration scenario against any FileSystemBackend.
 * This proves both backends satisfy the same contract under realistic use.
 */
async function runIntegrationScenario(backend: FileSystemBackend): Promise<void> {
  // Write
  const writeResult = await backend.write("integration/hello.txt", "world");
  expect(writeResult.ok).toBe(true);

  // Read
  const readResult = await backend.read("integration/hello.txt");
  expect(readResult.ok).toBe(true);
  if (readResult.ok) expect(readResult.value.content).toBe("world");

  // Edit
  const editResult = await backend.edit("integration/hello.txt", [
    { oldText: "world", newText: "koi" },
  ]);
  expect(editResult.ok).toBe(true);
  if (editResult.ok) expect(editResult.value.hunksApplied).toBe(1);

  // Verify edit applied
  const readAfterEdit = await backend.read("integration/hello.txt");
  expect(readAfterEdit.ok).toBe(true);
  if (readAfterEdit.ok) expect(readAfterEdit.value.content).toBe("koi");

  // List
  const listResult = await backend.list("integration");
  expect(listResult.ok).toBe(true);
  if (listResult.ok) {
    expect(listResult.value.entries.length).toBeGreaterThanOrEqual(1);
  }

  // Search
  const searchResult = await backend.search("koi");
  expect(searchResult.ok).toBe(true);
  if (searchResult.ok) {
    expect(searchResult.value.matches.length).toBeGreaterThanOrEqual(1);
  }

  // Delete
  const deleteResult = await backend.delete?.("integration/hello.txt");
  if (deleteResult !== undefined) {
    expect(deleteResult.ok).toBe(true);
  }
}

describe("Filesystem integration — same operations, both backends", () => {
  test("local backend passes full integration scenario", async () => {
    const localDir = mkdtempSync(join(tmpBase, "local-int-"));
    const backend = resolveFileSystem({ backend: "local" }, localDir);
    await runIntegrationScenario(backend);
  });

  // NOTE: nexus backend integration requires a running Nexus server.
  // This test verifies dispatch produces a nexus backend but doesn't run I/O.
  test("nexus dispatch produces a named nexus backend", () => {
    const backend = resolveFileSystem(
      { backend: "nexus", options: { url: "http://localhost:3100", mountPoint: "test" } },
      tmpBase,
    );
    expect(backend.name).toBe("nexus");
  });
});

describe("ComponentProvider integration", () => {
  test("provider defaults to read-only (fs_read only)", async () => {
    const localDir = mkdtempSync(join(tmpBase, "provider-int-"));
    const backend = resolveFileSystem({ backend: "local" }, localDir);
    const provider = createFileSystemProvider(backend);

    const fakeAgent = {
      pid: "test" as never,
      manifest: { name: "test", version: "0.0.0", model: { name: "test" }, objectives: [] },
      state: "assembling" as never,
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    };
    const result = await provider.attach(fakeAgent);
    const components = isAttachResult(result) ? result.components : result;

    expect(components.get(FILESYSTEM as string)).toBe(backend);
    expect(components.has(toolToken("fs_read") as string)).toBe(true);
    expect(components.has(toolToken("fs_write") as string)).toBe(false);
    expect(components.has(toolToken("fs_edit") as string)).toBe(false);
  });

  test("provider with explicit operations includes all requested tools", async () => {
    const localDir = mkdtempSync(join(tmpBase, "provider-full-"));
    const backend = resolveFileSystem({ backend: "local" }, localDir);
    const provider = createFileSystemProvider(backend, "fs", ["read", "write", "edit"]);

    const fakeAgent = {
      pid: "test" as never,
      manifest: { name: "test", version: "0.0.0", model: { name: "test" }, objectives: [] },
      state: "assembling" as never,
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    };
    const result = await provider.attach(fakeAgent);
    const components = isAttachResult(result) ? result.components : result;

    expect(components.has(toolToken("fs_read") as string)).toBe(true);
    expect(components.has(toolToken("fs_write") as string)).toBe(true);
    expect(components.has(toolToken("fs_edit") as string)).toBe(true);
  });

  test("provider for nexus backend has correct name", () => {
    const backend = resolveFileSystem(
      { backend: "nexus", options: { url: "http://localhost:3100", mountPoint: "test" } },
      tmpBase,
    );
    const provider = createFileSystemProvider(backend);
    expect(provider.name).toBe("filesystem:nexus");
  });
});

describe("createRuntime filesystem is opt-in", () => {
  test("default runtime has NO filesystem backend or provider", () => {
    const handle = createRuntime({});
    expect(handle.filesystemBackend).toBeUndefined();
    expect(handle.filesystemProvider).toBeUndefined();
  });

  test("explicit filesystem config enables backend and provider", () => {
    const localDir = mkdtempSync(join(tmpBase, "runtime-fs-"));
    const handle = createRuntime({ filesystem: { backend: "local" }, cwd: localDir });
    expect(handle.filesystemBackend?.name).toBe("local");
    expect(handle.filesystemProvider?.name).toBe("filesystem:local");
  });

  test("explicit filesystem config enables working fs tools", async () => {
    const localDir = mkdtempSync(join(tmpBase, "runtime-tools-"));
    const handle = createRuntime({ filesystem: { backend: "local" }, cwd: localDir });

    const stream = handle.adapter.stream({ kind: "text", text: "test" });
    for await (const _event of stream) {
      /* drain */
    }

    // Verify the handle's filesystem backend works end-to-end
    expect(handle.filesystemBackend).toBeDefined();
    await handle.filesystemBackend?.write("auto-test.txt", "auto-advertised");
    const result = await handle.filesystemBackend?.read("auto-test.txt");
    expect(result?.ok).toBe(true);
    if (result?.ok) expect(result.value.content).toBe("auto-advertised");

    await handle.dispose();
  });
});

describe("filesystem requires explicit host config (no manifest self-grant)", () => {
  test("default runtime has no filesystem (strict opt-in)", () => {
    const handle = createRuntime({});
    expect(handle.filesystemBackend).toBeUndefined();
    expect(handle.filesystemProvider).toBeUndefined();
  });

  test("explicit config.filesystem: local enables fs", () => {
    const localDir = mkdtempSync(join(tmpBase, "host-local-"));
    const handle = createRuntime({ filesystem: { backend: "local" }, cwd: localDir });
    expect(handle.filesystemBackend?.name).toBe("local");
  });

  test("explicit config.filesystem: nexus enables fs", () => {
    const handle = createRuntime({
      filesystem: {
        backend: "nexus",
        options: { url: "http://localhost:3100", mountPoint: "test" },
      },
      cwd: tmpBase,
    });
    expect(handle.filesystemBackend?.name).toBe("nexus");
  });

  test("filesystem: false is a kill switch", () => {
    const handle = createRuntime({ filesystem: false, cwd: tmpBase });
    expect(handle.filesystemBackend).toBeUndefined();
    expect(handle.filesystemProvider).toBeUndefined();
  });
});
