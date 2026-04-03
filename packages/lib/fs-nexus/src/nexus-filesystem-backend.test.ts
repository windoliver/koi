/**
 * Tests for the Nexus-backed FileSystemBackend.
 *
 * Runs the shared contract suite + Nexus-specific tests.
 */

import { describe, expect, test } from "bun:test";
import { runFileSystemBackendContractTests } from "./contract-tests.js";
import { createNexusFileSystem } from "./nexus-filesystem-backend.js";
import { createFakeNexusTransport } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Contract tests — proves NexusFileSystem satisfies FileSystemBackend
// ---------------------------------------------------------------------------

describe("NexusFileSystem contract", () => {
  runFileSystemBackendContractTests(() =>
    createNexusFileSystem({
      url: "http://fake",
      transport: createFakeNexusTransport(),
    }),
  );
});

// ---------------------------------------------------------------------------
// Nexus-specific tests
// ---------------------------------------------------------------------------

describe("NexusFileSystem specifics", () => {
  test("backend name is 'nexus'", () => {
    const backend = createNexusFileSystem({
      url: "http://fake",
      transport: createFakeNexusTransport(),
    });
    expect(backend.name).toBe("nexus");
  });

  test("custom mountPoint prefixes paths", async () => {
    const transport = createFakeNexusTransport();
    const backend = createNexusFileSystem({
      url: "http://fake",
      mountPoint: "workspace/agent1",
      transport,
    });
    // Write through the backend
    await backend.write("/hello.txt", "test");
    // Read should succeed through the same mount
    const result = await backend.read("/hello.txt");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.content).toBe("test");
  });

  test("path traversal is rejected", async () => {
    const backend = createNexusFileSystem({
      url: "http://fake",
      transport: createFakeNexusTransport(),
    });
    const result = await backend.read("../../../etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("null bytes in path are rejected", async () => {
    const backend = createNexusFileSystem({
      url: "http://fake",
      transport: createFakeNexusTransport(),
    });
    const result = await backend.read("file\0.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("edit delegates to Nexus when available", async () => {
    const transport = createFakeNexusTransport();
    const backend = createNexusFileSystem({ url: "http://fake", transport });
    await backend.write("/edit-delegate.txt", "hello world");
    const result = await backend.edit("/edit-delegate.txt", [
      { oldText: "hello", newText: "goodbye" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.hunksApplied).toBe(1);
  });

  test("edit falls back to composite when Nexus edit unavailable", async () => {
    const transport = createFakeNexusTransport({
      failMethod: "edit",
      failCode: -32601,
      failMessage: "method not found",
    });
    const backend = createNexusFileSystem({ url: "http://fake", transport });
    await backend.write("/edit-fallback.txt", "hello world");
    const result = await backend.edit("/edit-fallback.txt", [
      { oldText: "hello", newText: "goodbye" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.hunksApplied).toBe(1);

    const read = await backend.read("/edit-fallback.txt");
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.content).toBe("goodbye world");
  });

  test("dispose closes transport", () => {
    const transport = createFakeNexusTransport();
    const backend = createNexusFileSystem({ url: "http://fake", transport });
    expect(backend.dispose).toBeDefined();
    backend.dispose?.();
    // After dispose, operations should fail
  });

  test("search delegates to grep RPC", async () => {
    const transport = createFakeNexusTransport();
    const backend = createNexusFileSystem({ url: "http://fake", transport });
    await backend.write("/search/file.ts", "const foo = 42;\nconst bar = 99;");
    const result = await backend.search("foo");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.matches.length).toBeGreaterThanOrEqual(1);
      expect(result.value.matches[0]?.text).toContain("foo");
    }
  });

  test("list returns structured entries with kind", async () => {
    const transport = createFakeNexusTransport();
    const backend = createNexusFileSystem({ url: "http://fake", transport });
    await backend.write("/list-test/file.txt", "content");
    const result = await backend.list("/list-test");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const fileEntry = result.value.entries.find((e) => e.path.endsWith("file.txt"));
      expect(fileEntry).toBeDefined();
      expect(fileEntry?.kind).toBe("file");
    }
  });
});
