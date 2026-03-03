import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  assertOk,
  createTestSkillArtifact,
  createTestToolArtifact,
  testBrickRegistryContract,
} from "@koi/test-utils";
import { createSqliteBrickRegistry } from "../brick-registry.js";

// ---------------------------------------------------------------------------
// Contract tests
// ---------------------------------------------------------------------------

describe("SqliteBrickRegistry", () => {
  testBrickRegistryContract({
    createRegistry: () => {
      const db = new Database(":memory:");
      db.run("PRAGMA foreign_keys = ON");
      return createSqliteBrickRegistry({ db });
    },
  });

  // -------------------------------------------------------------------------
  // SQLite-specific tests
  // -------------------------------------------------------------------------

  describe("FTS5 search", () => {
    test("finds bricks by name substring", async () => {
      const db = new Database(":memory:");
      db.run("PRAGMA foreign_keys = ON");
      const registry = createSqliteBrickRegistry({ db });

      assertOk(await registry.register(createTestToolArtifact({ name: "calculator-tool" })));
      assertOk(await registry.register(createTestSkillArtifact({ name: "weather-skill" })));

      const page = await registry.search({ text: "calculator" });
      expect(page.items.length).toBe(1);
      expect(page.items[0]?.name).toBe("calculator-tool");
    });

    test("finds bricks by description", async () => {
      const db = new Database(":memory:");
      db.run("PRAGMA foreign_keys = ON");
      const registry = createSqliteBrickRegistry({ db });

      assertOk(
        await registry.register(
          createTestToolArtifact({ name: "my-tool", description: "performs complex calculations" }),
        ),
      );

      const page = await registry.search({ text: "calculations" });
      expect(page.items.length).toBe(1);
      expect(page.items[0]?.name).toBe("my-tool");
    });

    test("text search is case-insensitive", async () => {
      const db = new Database(":memory:");
      db.run("PRAGMA foreign_keys = ON");
      const registry = createSqliteBrickRegistry({ db });

      assertOk(await registry.register(createTestToolArtifact({ name: "MyTool" })));

      const page = await registry.search({ text: "mytool" });
      expect(page.items.length).toBe(1);
    });
  });

  describe("tag filtering", () => {
    test("AND-filters multiple tags", async () => {
      const db = new Database(":memory:");
      db.run("PRAGMA foreign_keys = ON");
      const registry = createSqliteBrickRegistry({ db });

      assertOk(
        await registry.register(createTestToolArtifact({ name: "tool-a", tags: ["math", "util"] })),
      );
      assertOk(
        await registry.register(createTestSkillArtifact({ name: "skill-b", tags: ["math"] })),
      );

      const page = await registry.search({ tags: ["math", "util"] });
      expect(page.items.length).toBe(1);
      expect(page.items[0]?.name).toBe("tool-a");
    });

    test("returns empty when no brick has all tags", async () => {
      const db = new Database(":memory:");
      db.run("PRAGMA foreign_keys = ON");
      const registry = createSqliteBrickRegistry({ db });

      assertOk(await registry.register(createTestToolArtifact({ name: "tool-a", tags: ["foo"] })));

      const page = await registry.search({ tags: ["foo", "bar"] });
      expect(page.items.length).toBe(0);
    });
  });

  describe("keyset cursor stability", () => {
    test("pages through all results without duplicates", async () => {
      const db = new Database(":memory:");
      db.run("PRAGMA foreign_keys = ON");
      const registry = createSqliteBrickRegistry({ db });

      for (let i = 0; i < 7; i++) {
        assertOk(await registry.register(createTestToolArtifact({ name: `tool-${i}` })));
      }

      const allNames = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- loop control
      while (true) {
        const query = cursor !== undefined ? { limit: 3, cursor } : { limit: 3 };
        const page = await registry.search(query);
        for (const item of page.items) {
          expect(allNames.has(item.name)).toBe(false);
          allNames.add(item.name);
        }
        pages++;
        if (page.cursor === undefined) break;
        cursor = page.cursor;
      }

      expect(allNames.size).toBe(7);
      expect(pages).toBe(3); // 3 + 3 + 1
    });
  });

  describe("re-registration (update path)", () => {
    test("updates existing brick and fires 'updated' event", async () => {
      const db = new Database(":memory:");
      db.run("PRAGMA foreign_keys = ON");
      const registry = createSqliteBrickRegistry({ db });

      const original = createTestToolArtifact({
        name: "updatable-tool",
        description: "original desc",
        tags: ["old-tag"],
      });
      assertOk(await registry.register(original));

      const events: string[] = [];
      if (registry.onChange === undefined) throw new Error("onChange must be defined");
      registry.onChange((e) => events.push(e.kind));

      const updated = createTestToolArtifact({
        name: "updatable-tool",
        description: "new desc",
        tags: ["new-tag"],
      });
      assertOk(await registry.register(updated));

      expect(events).toEqual(["updated"]);

      const result = await registry.get("tool", "updatable-tool");
      assertOk(result);
      expect(result.value.description).toBe("new desc");
      expect(result.value.tags).toEqual(["new-tag"]);

      // FTS still works after update
      const page = await registry.search({ text: "new desc" });
      expect(page.items.length).toBe(1);
    });
  });

  describe("cascade delete", () => {
    test("unregister removes associated tags", async () => {
      const db = new Database(":memory:");
      db.run("PRAGMA foreign_keys = ON");
      const registry = createSqliteBrickRegistry({ db });

      assertOk(
        await registry.register(createTestToolArtifact({ name: "cascade-tool", tags: ["a", "b"] })),
      );
      assertOk(await registry.unregister("tool", "cascade-tool"));

      // Verify tags are cleaned up (search by tags returns nothing)
      const page = await registry.search({ tags: ["a"] });
      expect(page.items.length).toBe(0);
      expect(page.total).toBe(0);
    });
  });

  describe("close()", () => {
    test("close does not throw", () => {
      const db = new Database(":memory:");
      db.run("PRAGMA foreign_keys = ON");
      const registry = createSqliteBrickRegistry({ db });
      registry.close();
    });
  });
});
