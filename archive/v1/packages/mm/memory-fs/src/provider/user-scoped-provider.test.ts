import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryComponent } from "@koi/core";
import { MEMORY, skillToken, toolToken } from "@koi/core";
import { createMockAgent } from "@koi/test-utils";
import { createUserScopedMemoryProvider } from "./user-scoped-provider.js";

// let — needed for mutable test directory
let testDir: string;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `koi-user-scoped-provider-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("createUserScopedMemoryProvider", () => {
  test("provider name is 'memory'", () => {
    const provider = createUserScopedMemoryProvider({ baseDir: testDir });
    expect(provider.name).toBe("memory");
  });

  test("creates per-user memory from agent context", async () => {
    const provider = createUserScopedMemoryProvider({ baseDir: testDir });

    const aliceAgent = createMockAgent({ pid: { ownerId: "alice" } });
    const components = await provider.attach(aliceAgent);
    const map =
      components instanceof Map
        ? components
        : (components as { readonly components: ReadonlyMap<string, unknown> }).components;

    // Should have MEMORY token, 3 tools, and skill = 5
    expect(map.size).toBe(5);
    expect(map.has(MEMORY as string)).toBe(true);
    expect(map.has(toolToken("memory_store") as string)).toBe(true);
    expect(map.has(toolToken("memory_recall") as string)).toBe(true);
    expect(map.has(toolToken("memory_search") as string)).toBe(true);
    expect(map.has(skillToken("memory") as string)).toBe(true);
  });

  test("falls back to shared when userId absent", async () => {
    const provider = createUserScopedMemoryProvider({ baseDir: testDir });

    // Agent without ownerId
    const agent = createMockAgent();
    const components = await provider.attach(agent);
    const map =
      components instanceof Map
        ? components
        : (components as { readonly components: ReadonlyMap<string, unknown> }).components;

    const component = map.get(MEMORY as string) as MemoryComponent;
    expect(component).toBeDefined();
    expect(typeof component.store).toBe("function");
    expect(typeof component.recall).toBe("function");
  });

  test("multiple agents with different userIds get isolated memory", async () => {
    const provider = createUserScopedMemoryProvider({ baseDir: testDir });

    const aliceAgent = createMockAgent({ pid: { ownerId: "alice" } });
    const bobAgent = createMockAgent({ pid: { ownerId: "bob" } });

    const aliceMap = await provider.attach(aliceAgent);
    const aliceComponents =
      aliceMap instanceof Map
        ? aliceMap
        : (aliceMap as { readonly components: ReadonlyMap<string, unknown> }).components;
    const aliceMemory = aliceComponents.get(MEMORY as string) as MemoryComponent;

    const bobMap = await provider.attach(bobAgent);
    const bobComponents =
      bobMap instanceof Map
        ? bobMap
        : (bobMap as { readonly components: ReadonlyMap<string, unknown> }).components;
    const bobMemory = bobComponents.get(MEMORY as string) as MemoryComponent;

    // Store different facts per user
    await aliceMemory.store("Alice secret preference", {
      relatedEntities: ["preference"],
      category: "preference",
    });
    await bobMemory.store("Bob secret preference", {
      relatedEntities: ["preference"],
      category: "preference",
    });

    // Each user only sees their own facts
    const aliceResults = await aliceMemory.recall("preference");
    expect(aliceResults).toHaveLength(1);
    expect(aliceResults[0]?.content).toBe("Alice secret preference");

    const bobResults = await bobMemory.recall("preference");
    expect(bobResults).toHaveLength(1);
    expect(bobResults[0]?.content).toBe("Bob secret preference");
  });

  test("detach rebuilds summaries for the user", async () => {
    const provider = createUserScopedMemoryProvider({ baseDir: testDir });

    const aliceAgent = createMockAgent({ pid: { ownerId: "alice" } });
    const aliceMap = await provider.attach(aliceAgent);
    const aliceComponents =
      aliceMap instanceof Map
        ? aliceMap
        : (aliceMap as { readonly components: ReadonlyMap<string, unknown> }).components;
    const aliceMemory = aliceComponents.get(MEMORY as string) as MemoryComponent;

    await aliceMemory.store("Alice fact for summary", {
      relatedEntities: ["test"],
      category: "context",
    });

    // Detach should not throw
    await provider.detach?.(aliceAgent);
  });

  test("detach rebuilds summaries for shared when no userId", async () => {
    const provider = createUserScopedMemoryProvider({ baseDir: testDir });

    const agent = createMockAgent();
    const map = await provider.attach(agent);
    const components =
      map instanceof Map
        ? map
        : (map as { readonly components: ReadonlyMap<string, unknown> }).components;
    const memory = components.get(MEMORY as string) as MemoryComponent;

    await memory.store("shared fact", { relatedEntities: ["test"] });

    // Detach should not throw
    await provider.detach?.(agent);
  });
});
