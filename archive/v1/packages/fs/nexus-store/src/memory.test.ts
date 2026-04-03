/**
 * Tests for the Nexus-backed MemoryPersistenceBackend in @koi/nexus-store.
 *
 * Uses a fake Nexus JSON-RPC server for testing memory fact persistence.
 */

import { describe, expect, test } from "bun:test";
import { createFakeNexusFetch } from "@koi/test-utils";
import type { MemoryFact } from "./memory.js";
import { createNexusMemoryBackend } from "./memory.js";

describe("createNexusMemoryBackend", () => {
  function createBackend(): ReturnType<typeof createNexusMemoryBackend> {
    return createNexusMemoryBackend({
      baseUrl: "http://fake-nexus",
      apiKey: "test-key",
      fetch: createFakeNexusFetch(),
    });
  }

  function makeFact(subject: string, predicate: string, object: string): MemoryFact {
    return {
      subject,
      predicate,
      object,
      confidence: 0.9,
      source: "test",
      createdAt: Date.now(),
    };
  }

  test("readFacts returns empty array for unknown entity", async () => {
    const backend = createBackend();
    const result = await backend.readFacts("nonexistent");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  test("writeFacts and readFacts round-trip", async () => {
    const backend = createBackend();
    const facts = [makeFact("Alice", "likes", "cats"), makeFact("Alice", "age", "30")];

    const writeResult = await backend.writeFacts("alice", facts);
    expect(writeResult.ok).toBe(true);

    const readResult = await backend.readFacts("alice");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value).toHaveLength(2);
      expect(readResult.value[0]?.subject).toBe("Alice");
      expect(readResult.value[1]?.predicate).toBe("age");
    }
  });

  test("removeFacts deletes entity facts", async () => {
    const backend = createBackend();
    await backend.writeFacts("bob", [makeFact("Bob", "likes", "dogs")]);

    const removeResult = await backend.removeFacts("bob");
    expect(removeResult.ok).toBe(true);

    const readResult = await backend.readFacts("bob");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value).toEqual([]);
    }
  });

  test("removeFacts returns NOT_FOUND for unknown entity", async () => {
    const backend = createBackend();
    const result = await backend.removeFacts("unknown");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("listEntities returns all stored entity names", async () => {
    const backend = createBackend();
    await backend.writeFacts("alice", [makeFact("Alice", "likes", "cats")]);
    await backend.writeFacts("bob", [makeFact("Bob", "likes", "dogs")]);
    await backend.writeFacts("charlie", [makeFact("Charlie", "likes", "birds")]);

    const result = await backend.listEntities();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(3);
      expect([...result.value].sort()).toEqual(["alice", "bob", "charlie"]);
    }
  });

  test("overwriting facts replaces the previous set", async () => {
    const backend = createBackend();
    await backend.writeFacts("alice", [makeFact("Alice", "likes", "cats")]);
    await backend.writeFacts("alice", [makeFact("Alice", "likes", "dogs")]);

    const result = await backend.readFacts("alice");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.object).toBe("dogs");
    }
  });

  test("custom basePath is respected", async () => {
    const calls: Array<{ readonly method: string; readonly path: string }> = [];
    const innerFetch = createFakeNexusFetch();

    const spyFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const body = JSON.parse(init?.body as string) as {
        readonly method: string;
        readonly params: Record<string, unknown>;
      };
      if (body.params.path !== undefined) {
        calls.push({ method: body.method, path: body.params.path as string });
      }
      return innerFetch(input, init);
    }) as typeof globalThis.fetch;

    const backend = createNexusMemoryBackend({
      baseUrl: "http://fake-nexus",
      apiKey: "test-key",
      fetch: spyFetch,
      basePath: "/custom/memory",
    });

    await backend.writeFacts("alice", [makeFact("Alice", "likes", "cats")]);

    const writeCalls = calls.filter((c) => c.method === "write");
    expect(writeCalls.length).toBe(1);
    expect(writeCalls[0]?.path).toBe("/custom/memory/alice.json");
  });

  test("handles Nexus errors gracefully", async () => {
    const failFetch = (async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      throw new Error("Network failure");
    }) as typeof globalThis.fetch;

    const backend = createNexusMemoryBackend({
      baseUrl: "http://fake-nexus",
      apiKey: "test-key",
      fetch: failFetch,
    });

    const result = await backend.writeFacts("alice", [makeFact("Alice", "likes", "cats")]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(true);
    }
  });
});
