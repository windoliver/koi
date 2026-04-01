/**
 * Integration tests for createWorkspaceStack.
 *
 * Uses fake Nexus fetch to verify the factory produces correct
 * raw pieces: backend, enforcer, retriever.
 */

import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import { agentId } from "@koi/core";
import type { Retriever, SearchPage, SearchQuery, SearchResult } from "@koi/search-provider";
import { createFakeNexusFetch } from "@koi/test-utils";
import { createScopedRetriever, createWorkspaceStack } from "./create-workspace-stack.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_AGENT_ID = agentId("agent_test_workspace");

function createStack(overrides?: {
  readonly permissions?: { readonly enabled?: boolean };
  readonly search?: { readonly enabled?: boolean; readonly minScore?: number };
  readonly scope?: { readonly root?: string };
}) {
  const fakeFetch = createFakeNexusFetch();
  return createWorkspaceStack({
    nexusBaseUrl: "http://fake-nexus",
    nexusApiKey: "test-key",
    agentId: TEST_AGENT_ID,
    permissions: { enabled: false, ...overrides?.permissions },
    search: { enabled: false, ...overrides?.search },
    scope: overrides?.scope,
    fetch: fakeFetch,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createWorkspaceStack", () => {
  test("write and read round-trip through raw backend", async () => {
    const stack = createStack();

    const writeResult = await stack.backend.write("/hello.txt", "hello workspace");
    expect(writeResult.ok).toBe(true);

    const readResult = await stack.backend.read("/hello.txt");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value.content).toBe("hello workspace");
    }
  });

  test("returns backend with nexus name", () => {
    const stack = createStack();
    expect(stack.backend.name).toBe("nexus");
  });

  test("default scope root uses agentId", async () => {
    const stack = createStack();
    const writeResult = await stack.backend.write("/test.txt", "data");
    expect(writeResult.ok).toBe(true);

    const readResult = await stack.backend.read("/test.txt");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value.content).toBe("data");
    }
  });

  test("custom scope root is used", async () => {
    const stack = createStack({ scope: { root: "/custom/root" } });

    const writeResult = await stack.backend.write("/file.txt", "custom root");
    expect(writeResult.ok).toBe(true);

    const readResult = await stack.backend.read("/file.txt");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value.content).toBe("custom root");
    }
  });

  test("minimal config works with defaults", () => {
    const fakeFetch = createFakeNexusFetch();
    const stack = createWorkspaceStack({
      nexusBaseUrl: "http://fake-nexus",
      nexusApiKey: "test-key",
      agentId: TEST_AGENT_ID,
      permissions: { enabled: false },
      search: { enabled: false },
      fetch: fakeFetch,
    });

    expect(stack.backend).toBeDefined();
  });

  // ── Enforcer ────────────────────────────────────────────────────────

  test("permissions disabled: no enforcer returned", () => {
    const stack = createStack({ permissions: { enabled: false } });
    expect(stack.enforcer).toBeUndefined();
  });

  test("permissions enabled: enforcer is returned", () => {
    const fakeFetch = createFakeNexusFetch();
    const stack = createWorkspaceStack({
      nexusBaseUrl: "http://fake-nexus",
      nexusApiKey: "test-key",
      agentId: TEST_AGENT_ID,
      permissions: { enabled: true },
      search: { enabled: false },
      fetch: fakeFetch,
    });
    expect(stack.enforcer).toBeDefined();
  });

  // ── Retriever ───────────────────────────────────────────────────────

  test("search disabled: no retriever returned", () => {
    const stack = createStack({ search: { enabled: false } });
    expect(stack.retriever).toBeUndefined();
  });

  test("search enabled: retriever is returned", () => {
    const fakeFetch = createFakeNexusFetch();
    const stack = createWorkspaceStack({
      nexusBaseUrl: "http://fake-nexus",
      nexusApiKey: "test-key",
      agentId: TEST_AGENT_ID,
      permissions: { enabled: false },
      search: { enabled: true },
      fetch: fakeFetch,
    });
    expect(stack.retriever).toBeDefined();
  });

  // ── Backend operations ──────────────────────────────────────────────

  test("delete removes file", async () => {
    const stack = createStack();
    await stack.backend.write("/deleteme.txt", "gone");

    const delResult = await stack.backend.delete?.("/deleteme.txt");
    expect(delResult?.ok).toBe(true);

    const readResult = await stack.backend.read("/deleteme.txt");
    expect(readResult.ok).toBe(false);
  });

  test("rename moves file", async () => {
    const stack = createStack();
    await stack.backend.write("/old.txt", "movable");

    const renameResult = await stack.backend.rename?.("/old.txt", "/new.txt");
    expect(renameResult?.ok).toBe(true);

    const oldRead = await stack.backend.read("/old.txt");
    expect(oldRead.ok).toBe(false);

    const newRead = await stack.backend.read("/new.txt");
    expect(newRead.ok).toBe(true);
    if (newRead.ok) {
      expect(newRead.value.content).toBe("movable");
    }
  });

  test("list returns written files", async () => {
    const stack = createStack();
    await stack.backend.write("/list-test/a.txt", "a");
    await stack.backend.write("/list-test/b.txt", "b");

    const listResult = await stack.backend.list("/list-test");
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value.entries.length).toBe(2);
    }
  });

  test("search finds content", async () => {
    const stack = createStack();
    await stack.backend.write("/searchable.txt", "unique needle in haystack");

    const searchResult = await stack.backend.search("unique needle");
    expect(searchResult.ok).toBe(true);
    if (searchResult.ok) {
      expect(searchResult.value.matches.length).toBeGreaterThanOrEqual(1);
    }
  });

  // ── Validation ──────────────────────────────────────────────────────

  test("throws on missing nexusBaseUrl", () => {
    expect(() =>
      createWorkspaceStack({
        nexusBaseUrl: "",
        nexusApiKey: "key",
        agentId: TEST_AGENT_ID,
      }),
    ).toThrow("nexusBaseUrl");
  });

  test("throws on missing nexusApiKey", () => {
    expect(() =>
      createWorkspaceStack({
        nexusBaseUrl: "http://fake",
        nexusApiKey: "",
        agentId: TEST_AGENT_ID,
      }),
    ).toThrow("nexusApiKey");
  });
});

// ---------------------------------------------------------------------------
// createScopedRetriever
// ---------------------------------------------------------------------------

function makeResult(path: string, score = 0.9): SearchResult {
  return {
    id: `${path}:0`,
    score,
    content: "some content",
    source: "nexus",
    metadata: { path },
  };
}

function createMockRetriever(results: readonly SearchResult[]): Retriever {
  return {
    retrieve: async (_query: SearchQuery): Promise<Result<SearchPage, KoiError>> => ({
      ok: true,
      value: {
        results,
        total: results.length,
        hasMore: false,
      },
    }),
  };
}

describe("createScopedRetriever", () => {
  test("filters results outside scopeRoot", async () => {
    const inner = createMockRetriever([
      makeResult("/agents/a/workspace/file.txt"),
      makeResult("/agents/b/workspace/file.txt"),
      makeResult("/agents/a/workspace/sub/deep.txt"),
    ]);

    const scoped = createScopedRetriever(inner, "/agents/a/workspace");
    const result = await scoped.retrieve({ text: "test", limit: 10 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.results.length).toBe(2);
      const paths = result.value.results.map((r) => r.metadata.path);
      expect(paths).toContain("/agents/a/workspace/file.txt");
      expect(paths).toContain("/agents/a/workspace/sub/deep.txt");
      expect(paths).not.toContain("/agents/b/workspace/file.txt");
      expect(result.value.total).toBe(2);
    }
  });

  test("does not match paths that share a prefix but differ at boundary", async () => {
    const inner = createMockRetriever([
      makeResult("/agents/ab/workspace/file.txt"),
      makeResult("/agents/a/workspace/file.txt"),
    ]);

    const scoped = createScopedRetriever(inner, "/agents/a/workspace");
    const result = await scoped.retrieve({ text: "test", limit: 10 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.results.length).toBe(1);
      expect(result.value.results[0]?.metadata.path).toBe("/agents/a/workspace/file.txt");
    }
  });

  test("allows exact scopeRoot match", async () => {
    const inner = createMockRetriever([makeResult("/agents/a/workspace")]);

    const scoped = createScopedRetriever(inner, "/agents/a/workspace");
    const result = await scoped.retrieve({ text: "test", limit: 10 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.results.length).toBe(1);
    }
  });

  test("returns empty results when none match scope", async () => {
    const inner = createMockRetriever([
      makeResult("/other/path/file.txt"),
      makeResult("/different/root/file.txt"),
    ]);

    const scoped = createScopedRetriever(inner, "/agents/a/workspace");
    const result = await scoped.retrieve({ text: "test", limit: 10 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.results.length).toBe(0);
      expect(result.value.total).toBe(0);
    }
  });

  test("passes through errors from inner retriever", async () => {
    const errorRetriever: Retriever = {
      retrieve: async (): Promise<Result<SearchPage, KoiError>> => ({
        ok: false,
        error: {
          code: "INTERNAL",
          message: "Search unavailable",
          retryable: false,
        },
      }),
    };

    const scoped = createScopedRetriever(errorRetriever, "/agents/a/workspace");
    const result = await scoped.retrieve({ text: "test", limit: 10 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Search unavailable");
    }
  });

  test("preserves cursor and hasMore from inner result", async () => {
    const inner: Retriever = {
      retrieve: async (): Promise<Result<SearchPage, KoiError>> => ({
        ok: true,
        value: {
          results: [makeResult("/agents/a/workspace/file.txt")],
          total: 5,
          hasMore: true,
          cursor: "next-page",
        },
      }),
    };

    const scoped = createScopedRetriever(inner, "/agents/a/workspace");
    const result = await scoped.retrieve({ text: "test", limit: 10 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.hasMore).toBe(true);
      expect(result.value.cursor).toBe("next-page");
    }
  });

  test("skips results with missing or non-string metadata.path", async () => {
    const inner = createMockRetriever([
      {
        id: "no-path:0",
        score: 0.9,
        content: "no path",
        source: "nexus",
        metadata: {},
      },
      {
        id: "num-path:0",
        score: 0.9,
        content: "numeric path",
        source: "nexus",
        metadata: { path: 42 },
      },
      makeResult("/agents/a/workspace/valid.txt"),
    ]);

    const scoped = createScopedRetriever(inner, "/agents/a/workspace");
    const result = await scoped.retrieve({ text: "test", limit: 10 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.results.length).toBe(1);
      expect(result.value.results[0]?.metadata.path).toBe("/agents/a/workspace/valid.txt");
    }
  });
});
