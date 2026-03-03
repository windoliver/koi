/**
 * Brick registry contract test suite.
 *
 * Validates that any BrickRegistryBackend implementation satisfies the L0 contract.
 * Usage: import { testBrickRegistryContract } from "@koi/test-utils" and call it
 * inside a describe() block with a factory function.
 */

import { describe, expect, test } from "bun:test";
import type { BrickRegistryBackend, BrickRegistryChangeEvent } from "@koi/core";
import { assertErr, assertOk } from "./assert-result.js";
import { createTestSkillArtifact, createTestToolArtifact } from "./brick-artifacts.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface BrickRegistryContractOptions {
  readonly createRegistry: () => BrickRegistryBackend | Promise<BrickRegistryBackend>;
}

// ---------------------------------------------------------------------------
// Contract tests
// ---------------------------------------------------------------------------

/**
 * Runs the brick registry contract test suite.
 *
 * Call this inside a `describe()` block. It registers tests that verify
 * the registry satisfies all L0 contract invariants.
 */
export function testBrickRegistryContract(options: BrickRegistryContractOptions): void {
  const { createRegistry } = options;

  describe("search()", () => {
    test("returns a BrickPage for empty registry", async () => {
      const registry = await createRegistry();
      const page = await registry.search({});
      expect(page.items).toEqual([]);
      expect(page.cursor).toBeUndefined();
    });

    test("returns registered bricks", async () => {
      const registry = await createRegistry();
      const brick = createTestToolArtifact({ name: "search-tool" });
      assertOk(await registry.register(brick));

      const page = await registry.search({});
      expect(page.items.length).toBe(1);
      expect(page.items[0]?.name).toBe("search-tool");
    });

    test("filters by kind", async () => {
      const registry = await createRegistry();
      assertOk(await registry.register(createTestToolArtifact({ name: "my-tool" })));
      assertOk(await registry.register(createTestSkillArtifact({ name: "my-skill" })));

      const page = await registry.search({ kind: "tool" });
      expect(page.items.length).toBe(1);
      expect(page.items[0]?.kind).toBe("tool");
    });
  });

  describe("get()", () => {
    test("returns NOT_FOUND for unknown name", async () => {
      const registry = await createRegistry();
      const result = await registry.get("tool", "nonexistent");
      assertErr(result);
      expect(result.error.code).toBe("NOT_FOUND");
    });

    test("returns brick after registration", async () => {
      const registry = await createRegistry();
      const brick = createTestToolArtifact({ name: "get-tool" });
      assertOk(await registry.register(brick));

      const result = await registry.get("tool", "get-tool");
      assertOk(result);
      expect(result.value.name).toBe("get-tool");
    });
  });

  describe("register + get round-trip", () => {
    test("round-trip succeeds", async () => {
      const registry = await createRegistry();
      const brick = createTestSkillArtifact({
        name: "roundtrip-skill",
        content: "# Round Trip",
      });

      assertOk(await registry.register(brick));

      const result = await registry.get("skill", "roundtrip-skill");
      assertOk(result);
      expect(result.value.name).toBe("roundtrip-skill");
      expect(result.value.kind).toBe("skill");
    });
  });

  describe("pagination", () => {
    test("respects limit", async () => {
      const registry = await createRegistry();
      for (let i = 0; i < 5; i++) {
        assertOk(await registry.register(createTestToolArtifact({ name: `tool-${i}` })));
      }

      const page = await registry.search({ limit: 2 });
      expect(page.items.length).toBe(2);
      expect(page.cursor).toBeDefined();
    });

    test("cursor retrieves next page", async () => {
      const registry = await createRegistry();
      for (let i = 0; i < 5; i++) {
        assertOk(await registry.register(createTestToolArtifact({ name: `tool-${i}` })));
      }

      const page1 = await registry.search({ limit: 2 });
      expect(page1.items.length).toBe(2);

      const page2 = await registry.search({
        limit: 2,
        ...(page1.cursor !== undefined ? { cursor: page1.cursor } : {}),
      });
      expect(page2.items.length).toBe(2);

      // No overlap between pages
      const page1Names = new Set(page1.items.map((i) => i.name));
      for (const item of page2.items) {
        expect(page1Names.has(item.name)).toBe(false);
      }
    });
  });

  describe("unregister()", () => {
    test("removes brick", async () => {
      const registry = await createRegistry();
      const brick = createTestToolArtifact({ name: "to-remove" });
      assertOk(await registry.register(brick));

      assertOk(await registry.unregister("tool", "to-remove"));

      const result = await registry.get("tool", "to-remove");
      assertErr(result);
      expect(result.error.code).toBe("NOT_FOUND");
    });

    test("returns NOT_FOUND for unknown", async () => {
      const registry = await createRegistry();
      const result = await registry.unregister("tool", "ghost");
      assertErr(result);
      expect(result.error.code).toBe("NOT_FOUND");
    });
  });

  describe("onChange()", () => {
    test("fires on register", async () => {
      const registry = await createRegistry();
      if (registry.onChange === undefined) return;

      const events: BrickRegistryChangeEvent[] = [];
      const unsub = registry.onChange((event) => {
        events.push(event);
      });

      assertOk(await registry.register(createTestToolArtifact({ name: "new-tool" })));
      expect(events.length).toBe(1);
      expect(events[0]?.kind).toBe("registered");
      expect(events[0]?.name).toBe("new-tool");
      unsub();
    });

    test("fires on unregister", async () => {
      const registry = await createRegistry();
      if (registry.onChange === undefined) return;

      assertOk(await registry.register(createTestToolArtifact({ name: "rm-tool" })));

      const events: BrickRegistryChangeEvent[] = [];
      const unsub = registry.onChange((event) => {
        events.push(event);
      });

      assertOk(await registry.unregister("tool", "rm-tool"));
      expect(events.length).toBe(1);
      expect(events[0]?.kind).toBe("unregistered");
      unsub();
    });

    test("stops after unsubscribe", async () => {
      const registry = await createRegistry();
      if (registry.onChange === undefined) return;

      const events: BrickRegistryChangeEvent[] = [];
      const unsub = registry.onChange((event) => {
        events.push(event);
      });

      assertOk(await registry.register(createTestToolArtifact({ name: "first" })));
      const countAfterFirst = events.length;

      unsub();

      assertOk(await registry.register(createTestSkillArtifact({ name: "second" })));
      expect(events.length).toBe(countAfterFirst);
    });
  });
}
