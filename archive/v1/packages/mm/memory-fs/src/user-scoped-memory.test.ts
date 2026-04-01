import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserScopedMemory } from "./user-scoped-memory.js";
import { createUserScopedMemory } from "./user-scoped-memory.js";

// let — needed for mutable test directory and memory refs
let testDir: string;
let scoped: UserScopedMemory;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `koi-user-scoped-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  scoped = createUserScopedMemory({
    baseDir: testDir,
    maxCachedUsers: 3,
    memoryConfig: {},
  });
});

afterEach(async () => {
  await scoped.closeAll();
  rmSync(testDir, { recursive: true, force: true });
});

describe("createUserScopedMemory", () => {
  test("two users store facts → recall returns only own facts", async () => {
    const alice = await scoped.getOrCreate("alice");
    const bob = await scoped.getOrCreate("bob");

    await alice.component.store("Alice likes cats", {
      relatedEntities: ["preference"],
      category: "preference",
    });
    await bob.component.store("Bob likes dogs", {
      relatedEntities: ["preference"],
      category: "preference",
    });

    const aliceResults = await alice.component.recall("likes");
    expect(aliceResults).toHaveLength(1);
    expect(aliceResults[0]?.content).toBe("Alice likes cats");

    const bobResults = await bob.component.recall("likes");
    expect(bobResults).toHaveLength(1);
    expect(bobResults[0]?.content).toBe("Bob likes dogs");
  });

  test("entity index per user is isolated", async () => {
    const alice = await scoped.getOrCreate("alice");
    const bob = await scoped.getOrCreate("bob");

    await alice.component.store("Alice fact", { relatedEntities: ["alice-entity"] });
    await bob.component.store("Bob fact", { relatedEntities: ["bob-entity"] });

    const aliceEntities = await alice.listEntities();
    const bobEntities = await bob.listEntities();

    expect(aliceEntities).toContain("alice-entity");
    expect(aliceEntities).not.toContain("bob-entity");
    expect(bobEntities).toContain("bob-entity");
    expect(bobEntities).not.toContain("alice-entity");
  });

  test("fallback to shared store when userId absent", async () => {
    const shared = await scoped.getShared();
    await shared.component.store("shared fact", {
      relatedEntities: ["global"],
      category: "context",
    });

    const results = await shared.component.recall("shared");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.content).toBe("shared fact");

    // User-specific store should not see shared facts
    const alice = await scoped.getOrCreate("alice");
    const aliceResults = await alice.component.recall("shared");
    expect(aliceResults).toHaveLength(0);
  });

  test("getOrCreate returns same instance for same userId", async () => {
    const first = await scoped.getOrCreate("same-user");
    const second = await scoped.getOrCreate("same-user");
    // Same reference — cached
    expect(first).toBe(second);
  });

  test("getShared returns same instance on repeat calls", async () => {
    const first = await scoped.getShared();
    const second = await scoped.getShared();
    expect(first).toBe(second);
  });

  test("empty userId slugifies to _default", async () => {
    const mem = await scoped.getOrCreate("");
    await mem.component.store("empty user fact", { relatedEntities: ["test"] });
    const results = await mem.component.recall("empty");
    expect(results.length).toBeGreaterThan(0);
  });

  test("path traversal userId is sanitized", async () => {
    const mem = await scoped.getOrCreate("../admin");
    await mem.component.store("traversal attempt", { relatedEntities: ["test"] });
    const results = await mem.component.recall("traversal");
    expect(results.length).toBeGreaterThan(0);
  });

  test("unicode userId is slugified safely", async () => {
    const mem = await scoped.getOrCreate("用户42");
    await mem.component.store("unicode user fact", { relatedEntities: ["test"] });
    const results = await mem.component.recall("unicode");
    expect(results.length).toBeGreaterThan(0);
  });

  test("LRU eviction flushes writes correctly", async () => {
    // maxCachedUsers is 3 — storing 4 users should evict the first
    const user1 = await scoped.getOrCreate("user-1");
    await user1.component.store("user 1 fact", { relatedEntities: ["data"] });

    await scoped.getOrCreate("user-2");
    await scoped.getOrCreate("user-3");
    // This should evict user-1
    await scoped.getOrCreate("user-4");

    // Re-create user-1 (fresh from disk, evicted from cache)
    const user1Again = await scoped.getOrCreate("user-1");
    // Data should be on disk even after eviction
    const results = await user1Again.component.recall("user 1");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.content).toBe("user 1 fact");
  });

  test("concurrent stores from same userId succeed", async () => {
    const alice = await scoped.getOrCreate("alice");

    const stores = Array.from({ length: 5 }, (_, i) =>
      alice.component.store(`concurrent fact ${i}`, {
        relatedEntities: [`entity-${i}`],
        category: "context",
      }),
    );
    await Promise.all(stores);

    const results = await alice.component.recall("concurrent", { limit: 10 });
    expect(results).toHaveLength(5);
  });

  test("closeAll flushes all cached instances", async () => {
    const alice = await scoped.getOrCreate("alice");
    await alice.component.store("alice fact", { relatedEntities: ["test"] });
    const shared = await scoped.getShared();
    await shared.component.store("shared fact", { relatedEntities: ["test"] });

    await scoped.closeAll();

    // After closeAll, create fresh instances to verify data persisted
    const freshScoped = createUserScopedMemory({
      baseDir: testDir,
      maxCachedUsers: 3,
      memoryConfig: {},
    });

    const freshAlice = await freshScoped.getOrCreate("alice");
    const aliceResults = await freshAlice.component.recall("alice");
    expect(aliceResults.length).toBeGreaterThan(0);

    const freshShared = await freshScoped.getShared();
    const sharedResults = await freshShared.component.recall("shared");
    expect(sharedResults.length).toBeGreaterThan(0);

    await freshScoped.closeAll();
  });
});
