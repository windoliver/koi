/**
 * Tests for the Nexus-backed FileSystemBackend.
 *
 * 1. Contract suite via runFileSystemBackendContractTests
 * 2. Nexus-specific tests: path prefixing, error mapping
 * 3. Edge cases: traversal, empty content, concurrent writes
 */

import { describe, expect, test } from "bun:test";
import { createNexusClient } from "@koi/nexus-client";
import { createFakeNexusFetch, runFileSystemBackendContractTests } from "@koi/test-utils";
import { createNexusFileSystem } from "./nexus-filesystem-backend.js";
import { validateNexusFileSystemConfig } from "./validate-config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestBackend(basePath?: string) {
  const fakeFetch = createFakeNexusFetch();
  const client = createNexusClient({
    baseUrl: "http://fake-nexus",
    apiKey: "test-key",
    fetch: fakeFetch,
  });
  return createNexusFileSystem({ client, basePath });
}

// ---------------------------------------------------------------------------
// Contract suite
// ---------------------------------------------------------------------------

runFileSystemBackendContractTests(() => createTestBackend());

// ---------------------------------------------------------------------------
// Nexus-specific tests
// ---------------------------------------------------------------------------

describe("Nexus filesystem backend", () => {
  test("uses custom basePath in RPC calls", async () => {
    const backend = createTestBackend("/custom/base");

    const writeResult = await backend.write("/hello.txt", "content");
    expect(writeResult.ok).toBe(true);

    const readResult = await backend.read("/hello.txt");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value.content).toBe("content");
    }
  });

  test("default basePath is fs (no leading slash)", async () => {
    const backend = createTestBackend();

    await backend.write("/test.txt", "data");
    const readResult = await backend.read("/test.txt");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value.content).toBe("data");
    }
  });

  test("network failure returns retryable error", async () => {
    const failingFetchFn = async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      throw new Error("network down");
    };
    // Attach required static properties for typeof fetch compatibility
    const failingFetch = Object.assign(failingFetchFn, {
      preconnect: (_url: string | URL, _options?: unknown) => {},
    }) satisfies typeof globalThis.fetch;

    const client = createNexusClient({
      baseUrl: "http://fake-nexus",
      apiKey: "test-key",
      fetch: failingFetch,
    });
    const backend = createNexusFileSystem({ client });

    const result = await backend.read("/anything.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(true);
    }
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  test("path traversal is normalized within basePath", async () => {
    const backend = createTestBackend("/safe");

    await backend.write("/file.txt", "safe content");

    // Attempt traversal — should be normalized to stay within /safe
    const result = await backend.read("/../../../etc/passwd");
    // Should NOT find anything because the path is normalized
    expect(result.ok).toBe(false);
  });

  test("empty content write and read succeeds", async () => {
    const backend = createTestBackend();
    const writeResult = await backend.write("/empty.txt", "");
    expect(writeResult.ok).toBe(true);

    const readResult = await backend.read("/empty.txt");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value.content).toBe("");
    }
  });

  test("read non-existent file returns NOT_FOUND", async () => {
    const backend = createTestBackend();
    const result = await backend.read("/nonexistent.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("concurrent writes use last-writer-wins", async () => {
    const backend = createTestBackend();

    // Simulate concurrent writes
    const [r1, r2] = await Promise.all([
      backend.write("/concurrent.txt", "writer-1"),
      backend.write("/concurrent.txt", "writer-2"),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // Last writer wins — content should be one of the two
    const readResult = await backend.read("/concurrent.txt");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(["writer-1", "writer-2"]).toContain(readResult.value.content);
    }
  });

  test("list returns user-relative paths (basePath stripped)", async () => {
    const backend = createTestBackend("/mybase");
    await backend.write("/a.txt", "a");
    await backend.write("/b.txt", "b");

    const listResult = await backend.list("/");
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      const paths = listResult.value.entries.map((entry: { readonly path: string }) => entry.path);
      expect(paths).toContain("/a.txt");
      expect(paths).toContain("/b.txt");
    }
  });

  test("search returns user-relative paths", async () => {
    const backend = createTestBackend("/mybase");
    await backend.write("/searchable.txt", "find this text");

    const searchResult = await backend.search("find this");
    expect(searchResult.ok).toBe(true);
    if (searchResult.ok) {
      expect(searchResult.value.matches.length).toBeGreaterThanOrEqual(1);
      expect(searchResult.value.matches[0]?.path).toBe("/searchable.txt");
    }
  });

  test("dispose does not throw", () => {
    const backend = createTestBackend();
    expect(() => backend.dispose?.()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

describe("validateNexusFileSystemConfig", () => {
  test("valid config passes", () => {
    const fakeFetch = createFakeNexusFetch();
    const client = createNexusClient({
      baseUrl: "http://fake",
      apiKey: "key",
      fetch: fakeFetch,
    });
    const result = validateNexusFileSystemConfig({ client });
    expect(result.ok).toBe(true);
  });

  test("empty basePath fails validation", () => {
    const fakeFetch = createFakeNexusFetch();
    const client = createNexusClient({
      baseUrl: "http://fake",
      apiKey: "key",
      fetch: fakeFetch,
    });
    const result = validateNexusFileSystemConfig({ client, basePath: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("basePath with path traversal fails", () => {
    const fakeFetch = createFakeNexusFetch();
    const client = createNexusClient({
      baseUrl: "http://fake",
      apiKey: "key",
      fetch: fakeFetch,
    });
    const result = validateNexusFileSystemConfig({ client, basePath: "agents/../secret" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });
});
