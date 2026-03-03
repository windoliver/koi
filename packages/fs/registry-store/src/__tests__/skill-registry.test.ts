import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { SkillPublishRequest } from "@koi/core";
import { skillId } from "@koi/core";
import { assertOk, testSkillRegistryContract } from "@koi/test-utils";
import { createSqliteSkillRegistry } from "../skill-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  return db;
}

function makeReq(overrides?: Partial<SkillPublishRequest>): SkillPublishRequest {
  return {
    id: skillId("test-skill"),
    name: "Test Skill",
    description: "A skill for testing",
    tags: ["test", "contract"],
    version: "1.0.0",
    content: "# Test Skill\n\nHello world",
    author: "tester",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Contract tests
// ---------------------------------------------------------------------------

describe("SqliteSkillRegistry", () => {
  testSkillRegistryContract({
    createRegistry: () => {
      return createSqliteSkillRegistry({ db: createDb() });
    },
  });

  // -------------------------------------------------------------------------
  // SQLite-specific tests
  // -------------------------------------------------------------------------

  describe("multi-version storage", () => {
    test("stores and retrieves multiple versions", async () => {
      const registry = createSqliteSkillRegistry({ db: createDb() });
      const id = skillId("multi-ver");

      assertOk(await registry.publish(makeReq({ id, version: "1.0.0", content: "v1" })));
      assertOk(await registry.publish(makeReq({ id, version: "2.0.0", content: "v2" })));
      assertOk(await registry.publish(makeReq({ id, version: "3.0.0", content: "v3" })));

      const result = await registry.versions(id);
      assertOk(result);
      expect(result.value.length).toBe(3);
      expect(result.value[0]?.version).toBe("3.0.0");
      expect(result.value[2]?.version).toBe("1.0.0");
    });
  });

  describe("download counting", () => {
    test("tracks downloads across multiple installs", async () => {
      const registry = createSqliteSkillRegistry({ db: createDb() });
      const req = makeReq();
      assertOk(await registry.publish(req));

      for (let i = 0; i < 5; i++) {
        assertOk(await registry.install(req.id));
      }

      const result = await registry.get(req.id);
      assertOk(result);
      expect(result.value.downloads).toBe(5);
    });
  });

  describe("content retrieval", () => {
    test("installs specific version content", async () => {
      const registry = createSqliteSkillRegistry({ db: createDb() });
      const id = skillId("content-test");

      assertOk(await registry.publish(makeReq({ id, version: "1.0.0", content: "# V1" })));
      assertOk(await registry.publish(makeReq({ id, version: "2.0.0", content: "# V2" })));

      const v1 = await registry.install(id, "1.0.0");
      assertOk(v1);
      expect(v1.value.content).toBe("# V1");

      const v2 = await registry.install(id, "2.0.0");
      assertOk(v2);
      expect(v2.value.content).toBe("# V2");
    });

    test("latest install gets newest version content", async () => {
      const registry = createSqliteSkillRegistry({ db: createDb() });
      const id = skillId("latest-content");

      assertOk(await registry.publish(makeReq({ id, version: "1.0.0", content: "old" })));
      assertOk(await registry.publish(makeReq({ id, version: "2.0.0", content: "new" })));

      const result = await registry.install(id);
      assertOk(result);
      expect(result.value.content).toBe("new");
    });
  });

  describe("FTS5 search", () => {
    test("finds skills by name", async () => {
      const registry = createSqliteSkillRegistry({ db: createDb() });

      assertOk(await registry.publish(makeReq({ id: skillId("alpha"), name: "Alpha Analyzer" })));
      assertOk(
        await registry.publish(
          makeReq({ id: skillId("beta"), name: "Beta Builder", version: "1.0.0" }),
        ),
      );

      const page = await registry.search({ text: "alpha" });
      expect(page.items.length).toBe(1);
      expect(page.items[0]?.name).toBe("Alpha Analyzer");
    });

    test("finds skills by description", async () => {
      const registry = createSqliteSkillRegistry({ db: createDb() });

      assertOk(
        await registry.publish(
          makeReq({ id: skillId("desc"), description: "handles complex workflows" }),
        ),
      );

      const page = await registry.search({ text: "workflows" });
      expect(page.items.length).toBe(1);
    });
  });

  describe("deprecate idempotency", () => {
    test("deprecating an already-deprecated version succeeds", async () => {
      const registry = createSqliteSkillRegistry({ db: createDb() });
      const id = skillId("deprecate-test");

      assertOk(await registry.publish(makeReq({ id, version: "1.0.0" })));

      // First deprecate
      const first = await registry.deprecate(id, "1.0.0");
      assertOk(first);

      // Second deprecate — should not fail
      const second = await registry.deprecate(id, "1.0.0");
      assertOk(second);

      // Verify version is still deprecated
      const vers = await registry.versions(id);
      assertOk(vers);
      expect(vers.value[0]?.deprecated).toBe(true);
    });

    test("deprecating a non-existent version returns not-found", async () => {
      const registry = createSqliteSkillRegistry({ db: createDb() });
      const id = skillId("no-ver");

      assertOk(await registry.publish(makeReq({ id, version: "1.0.0" })));

      const result = await registry.deprecate(id, "99.0.0");
      expect(result.ok).toBe(false);
    });
  });

  describe("cascade delete on unpublish", () => {
    test("unpublish removes versions and tags", async () => {
      const registry = createSqliteSkillRegistry({ db: createDb() });
      const id = skillId("cascade-skill");

      assertOk(await registry.publish(makeReq({ id, version: "1.0.0", tags: ["x", "y"] })));
      assertOk(await registry.publish(makeReq({ id, version: "2.0.0", tags: ["x", "y"] })));

      assertOk(await registry.unpublish(id));

      // Skill no longer findable
      const result = await registry.get(id);
      expect(result.ok).toBe(false);

      // Tags don't pollute search
      const page = await registry.search({ tags: ["x"] });
      expect(page.items.length).toBe(0);
    });
  });

  describe("close()", () => {
    test("close does not throw", () => {
      const registry = createSqliteSkillRegistry({ db: createDb() });
      registry.close();
    });
  });
});
