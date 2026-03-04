/**
 * Integration tests for createWorkspaceStack.
 *
 * Uses fake Nexus fetch to verify the factory produces correct
 * raw pieces: backend, enforcer, retriever.
 */

import { describe, expect, test } from "bun:test";
import { agentId } from "@koi/core";
import { createFakeNexusFetch } from "@koi/test-utils";
import { createWorkspaceStack } from "./create-workspace-stack.js";

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
