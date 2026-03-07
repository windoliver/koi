/**
 * Skill registry contract test suite.
 *
 * Validates that any SkillRegistryBackend implementation satisfies the L0 contract.
 * Usage: import { testSkillRegistryContract } from "@koi/test-utils" and call it
 * inside a describe() block with a factory function.
 */

import { describe, expect, test } from "bun:test";
import type {
  SkillPublishRequest,
  SkillRegistryBackend,
  SkillRegistryChangeEvent,
} from "@koi/core";
import { skillId } from "@koi/core";
import { assertErr, assertKoiError, assertOk } from "@koi/test-utils-mocks";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SkillRegistryContractOptions {
  readonly createRegistry: () => SkillRegistryBackend | Promise<SkillRegistryBackend>;
}

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function makePublishRequest(overrides?: Partial<SkillPublishRequest>): SkillPublishRequest {
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

/**
 * Runs the skill registry contract test suite.
 *
 * Call this inside a `describe()` block. It registers tests that verify
 * the registry satisfies all L0 contract invariants.
 */
export function testSkillRegistryContract(options: SkillRegistryContractOptions): void {
  const { createRegistry } = options;

  // -------------------------------------------------------------------------
  // publish()
  // -------------------------------------------------------------------------

  describe("publish()", () => {
    test("publishes and returns entry", async () => {
      const registry = await createRegistry();
      const req = makePublishRequest();
      const result = await registry.publish(req);
      assertOk(result);
      expect(result.value.id).toBe(req.id);
      expect(result.value.name).toBe(req.name);
      expect(result.value.description).toBe(req.description);
      expect(result.value.tags).toEqual(req.tags);
      expect(result.value.version).toBe(req.version);
      expect(typeof result.value.publishedAt).toBe("number");
    });

    test("returns VALIDATION for empty name", async () => {
      const registry = await createRegistry();
      const req = makePublishRequest({ name: "" });
      const result = await registry.publish(req);
      assertErr(result);
      assertKoiError(result.error, { code: "VALIDATION" });
    });

    test("returns VALIDATION for empty version", async () => {
      const registry = await createRegistry();
      const req = makePublishRequest({ version: "" });
      const result = await registry.publish(req);
      assertErr(result);
      assertKoiError(result.error, { code: "VALIDATION" });
    });

    test("returns CONFLICT for duplicate version", async () => {
      const registry = await createRegistry();
      const req = makePublishRequest();
      const first = await registry.publish(req);
      assertOk(first);

      const duplicate = await registry.publish(req);
      assertErr(duplicate);
      assertKoiError(duplicate.error, { code: "CONFLICT" });
    });

    test("returns VALIDATION for whitespace-only name", async () => {
      const registry = await createRegistry();
      const req = makePublishRequest({ name: "   " });
      const result = await registry.publish(req);
      assertErr(result);
      assertKoiError(result.error, { code: "VALIDATION" });
    });

    test("returns VALIDATION for whitespace-only version", async () => {
      const registry = await createRegistry();
      const req = makePublishRequest({ version: "  " });
      const result = await registry.publish(req);
      assertErr(result);
      assertKoiError(result.error, { code: "VALIDATION" });
    });

    test("passes through requires to entry", async () => {
      const registry = await createRegistry();
      const requires = { bins: ["git"], env: ["API_KEY"] };
      const req = makePublishRequest({ requires });
      const result = await registry.publish(req);
      assertOk(result);
      expect(result.value.requires).toEqual(requires);

      // Also verify via get
      const getResult = await registry.get(req.id);
      assertOk(getResult);
      expect(getResult.value.requires).toEqual(requires);
    });

    test("allows multiple versions of same skill", async () => {
      const registry = await createRegistry();
      const v1 = makePublishRequest({ version: "1.0.0" });
      const v2 = makePublishRequest({ version: "2.0.0" });

      const r1 = await registry.publish(v1);
      assertOk(r1);

      const r2 = await registry.publish(v2);
      assertOk(r2);
      expect(r2.value.version).toBe("2.0.0");
    });
  });

  // -------------------------------------------------------------------------
  // search()
  // -------------------------------------------------------------------------

  describe("search()", () => {
    test("empty page when no skills", async () => {
      const registry = await createRegistry();
      const page = await registry.search({});
      expect(page.items).toEqual([]);
      expect(page.cursor).toBeUndefined();
    });

    test("returns published skills", async () => {
      const registry = await createRegistry();
      const req = makePublishRequest();
      assertOk(await registry.publish(req));

      const page = await registry.search({});
      expect(page.items.length).toBe(1);
      expect(page.items[0]?.id).toBe(req.id);
    });

    test("filters by text (case-insensitive)", async () => {
      const registry = await createRegistry();
      assertOk(
        await registry.publish(makePublishRequest({ id: skillId("alpha"), name: "Alpha Skill" })),
      );
      assertOk(
        await registry.publish(
          makePublishRequest({
            id: skillId("beta"),
            name: "Beta Tool",
            version: "1.0.0",
          }),
        ),
      );

      const page = await registry.search({ text: "alpha" });
      expect(page.items.length).toBe(1);
      expect(page.items[0]?.name).toBe("Alpha Skill");
    });

    test("filters by tags (AND match)", async () => {
      const registry = await createRegistry();
      assertOk(
        await registry.publish(
          makePublishRequest({
            id: skillId("a"),
            name: "Skill A",
            tags: ["foo", "bar"],
          }),
        ),
      );
      assertOk(
        await registry.publish(
          makePublishRequest({
            id: skillId("b"),
            name: "Skill B",
            tags: ["foo"],
            version: "1.0.0",
          }),
        ),
      );

      const page = await registry.search({ tags: ["foo", "bar"] });
      expect(page.items.length).toBe(1);
      expect(page.items[0]?.name).toBe("Skill A");
    });

    test("filters by author", async () => {
      const registry = await createRegistry();
      assertOk(
        await registry.publish(
          makePublishRequest({
            id: skillId("x"),
            name: "Skill X",
            author: "alice",
          }),
        ),
      );
      assertOk(
        await registry.publish(
          makePublishRequest({
            id: skillId("y"),
            name: "Skill Y",
            author: "bob",
            version: "1.0.0",
          }),
        ),
      );

      const page = await registry.search({ author: "alice" });
      expect(page.items.length).toBe(1);
      expect(page.items[0]?.name).toBe("Skill X");
    });
  });

  // -------------------------------------------------------------------------
  // pagination
  // -------------------------------------------------------------------------

  describe("pagination", () => {
    async function seedMultiple(registry: SkillRegistryBackend, count: number): Promise<void> {
      for (let i = 0; i < count; i++) {
        const id = skillId(`skill-${String(i).padStart(3, "0")}`);
        assertOk(
          await registry.publish(makePublishRequest({ id, name: `Skill ${i}`, version: "1.0.0" })),
        );
      }
    }

    test("cursor present when more results", async () => {
      const registry = await createRegistry();
      await seedMultiple(registry, 5);

      const page = await registry.search({ limit: 2 });
      expect(page.items.length).toBe(2);
      expect(page.cursor).toBeDefined();
    });

    test("cursor undefined when no more results", async () => {
      const registry = await createRegistry();
      await seedMultiple(registry, 3);

      const page = await registry.search({ limit: 10 });
      expect(page.items.length).toBe(3);
      expect(page.cursor).toBeUndefined();
    });

    test("cursor retrieves next page", async () => {
      const registry = await createRegistry();
      await seedMultiple(registry, 5);

      const page1 = await registry.search({ limit: 2 });
      expect(page1.items.length).toBe(2);
      expect(page1.cursor).toBeDefined();

      const nextQuery =
        page1.cursor !== undefined ? { limit: 2, cursor: page1.cursor } : { limit: 2 };
      const page2 = await registry.search(nextQuery);
      expect(page2.items.length).toBe(2);

      // No overlap between pages
      const page1Ids = new Set(page1.items.map((i) => i.id));
      for (const item of page2.items) {
        expect(page1Ids.has(item.id)).toBe(false);
      }
    });

    test("undefined cursor returns first page", async () => {
      const registry = await createRegistry();
      await seedMultiple(registry, 3);

      const page = await registry.search({ limit: 10 });
      expect(page.items.length).toBe(3);
    });

    test("total reflects full count when provided", async () => {
      const registry = await createRegistry();
      await seedMultiple(registry, 5);

      const page = await registry.search({ limit: 2 });
      if (page.total !== undefined) {
        expect(page.total).toBe(5);
      }
    });
  });

  // -------------------------------------------------------------------------
  // get()
  // -------------------------------------------------------------------------

  describe("get()", () => {
    test("returns entry for published skill", async () => {
      const registry = await createRegistry();
      const req = makePublishRequest();
      assertOk(await registry.publish(req));

      const result = await registry.get(req.id);
      assertOk(result);
      expect(result.value.id).toBe(req.id);
      expect(result.value.name).toBe(req.name);
    });

    test("returns NOT_FOUND for unknown", async () => {
      const registry = await createRegistry();
      const result = await registry.get(skillId("unknown"));
      assertErr(result);
      assertKoiError(result.error, { code: "NOT_FOUND" });
    });
  });

  // -------------------------------------------------------------------------
  // versions()
  // -------------------------------------------------------------------------

  describe("versions()", () => {
    test("returns all versions newest first", async () => {
      const registry = await createRegistry();
      const id = skillId("versioned");
      assertOk(await registry.publish(makePublishRequest({ id, version: "1.0.0" })));
      assertOk(await registry.publish(makePublishRequest({ id, version: "2.0.0" })));

      const result = await registry.versions(id);
      assertOk(result);
      expect(result.value.length).toBe(2);
      expect(result.value[0]?.version).toBe("2.0.0");
      expect(result.value[1]?.version).toBe("1.0.0");
    });

    test("returns NOT_FOUND for unknown", async () => {
      const registry = await createRegistry();
      const result = await registry.versions(skillId("unknown"));
      assertErr(result);
      assertKoiError(result.error, { code: "NOT_FOUND" });
    });

    test("includes integrity and publishedAt", async () => {
      const registry = await createRegistry();
      const id = skillId("with-integrity");
      assertOk(await registry.publish(makePublishRequest({ id, integrity: "sha256-abc123" })));

      const result = await registry.versions(id);
      assertOk(result);
      expect(result.value.length).toBe(1);
      expect(typeof result.value[0]?.publishedAt).toBe("number");
      expect(result.value[0]?.integrity).toBe("sha256-abc123");
    });
  });

  // -------------------------------------------------------------------------
  // install()
  // -------------------------------------------------------------------------

  describe("install()", () => {
    test("returns SkillArtifact with content", async () => {
      const registry = await createRegistry();
      const req = makePublishRequest({ content: "# My Skill" });
      assertOk(await registry.publish(req));

      const result = await registry.install(req.id);
      assertOk(result);
      expect(result.value.kind).toBe("skill");
      expect(result.value.content).toBe("# My Skill");
      expect(result.value.name).toBe(req.name);
    });

    test("installs specific version", async () => {
      const registry = await createRegistry();
      const id = skillId("multi-ver");
      assertOk(
        await registry.publish(makePublishRequest({ id, version: "1.0.0", content: "v1 content" })),
      );
      assertOk(
        await registry.publish(makePublishRequest({ id, version: "2.0.0", content: "v2 content" })),
      );

      const result = await registry.install(id, "1.0.0");
      assertOk(result);
      expect(result.value.content).toBe("v1 content");
      expect(result.value.version).toBe("1.0.0");
    });

    test("installs latest when version omitted", async () => {
      const registry = await createRegistry();
      const id = skillId("latest-test");
      assertOk(
        await registry.publish(makePublishRequest({ id, version: "1.0.0", content: "old" })),
      );
      assertOk(
        await registry.publish(makePublishRequest({ id, version: "2.0.0", content: "new" })),
      );

      const result = await registry.install(id);
      assertOk(result);
      expect(result.value.content).toBe("new");
      expect(result.value.version).toBe("2.0.0");
    });

    test("returns NOT_FOUND for unknown skill", async () => {
      const registry = await createRegistry();
      const result = await registry.install(skillId("nope"));
      assertErr(result);
      assertKoiError(result.error, { code: "NOT_FOUND" });
    });

    test("returns NOT_FOUND for unknown version", async () => {
      const registry = await createRegistry();
      const req = makePublishRequest();
      assertOk(await registry.publish(req));

      const result = await registry.install(req.id, "99.0.0");
      assertErr(result);
      assertKoiError(result.error, { code: "NOT_FOUND" });
    });

    test("increments download count on install", async () => {
      const registry = await createRegistry();
      const req = makePublishRequest();
      assertOk(await registry.publish(req));

      // Before any install — downloads may be undefined or 0
      const before = await registry.get(req.id);
      assertOk(before);
      const initialDownloads = before.value.downloads ?? 0;

      // Install twice
      assertOk(await registry.install(req.id));
      assertOk(await registry.install(req.id));

      const after = await registry.get(req.id);
      assertOk(after);
      if (after.value.downloads !== undefined) {
        expect(after.value.downloads).toBe(initialDownloads + 2);
      }
    });
  });

  // -------------------------------------------------------------------------
  // unpublish()
  // -------------------------------------------------------------------------

  describe("unpublish()", () => {
    test("removes published skill", async () => {
      const registry = await createRegistry();
      const req = makePublishRequest();
      assertOk(await registry.publish(req));

      const result = await registry.unpublish(req.id);
      assertOk(result);

      // Verify it's gone
      const getResult = await registry.get(req.id);
      assertErr(getResult);
      assertKoiError(getResult.error, { code: "NOT_FOUND" });
    });

    test("returns NOT_FOUND for unknown", async () => {
      const registry = await createRegistry();
      const result = await registry.unpublish(skillId("ghost"));
      assertErr(result);
      assertKoiError(result.error, { code: "NOT_FOUND" });
    });
  });

  // -------------------------------------------------------------------------
  // deprecate()
  // -------------------------------------------------------------------------

  describe("deprecate()", () => {
    test("marks version deprecated", async () => {
      const registry = await createRegistry();
      const req = makePublishRequest();
      assertOk(await registry.publish(req));

      const result = await registry.deprecate(req.id, req.version);
      assertOk(result);

      const versions = await registry.versions(req.id);
      assertOk(versions);
      expect(versions.value[0]?.deprecated).toBe(true);
    });

    test("returns NOT_FOUND for unknown skill", async () => {
      const registry = await createRegistry();
      const result = await registry.deprecate(skillId("none"), "1.0.0");
      assertErr(result);
      assertKoiError(result.error, { code: "NOT_FOUND" });
    });

    test("returns NOT_FOUND for unknown version", async () => {
      const registry = await createRegistry();
      const req = makePublishRequest();
      assertOk(await registry.publish(req));

      const result = await registry.deprecate(req.id, "99.0.0");
      assertErr(result);
      assertKoiError(result.error, { code: "NOT_FOUND" });
    });

    test("deprecating same version twice is idempotent", async () => {
      const registry = await createRegistry();
      const req = makePublishRequest();
      assertOk(await registry.publish(req));

      assertOk(await registry.deprecate(req.id, req.version));
      assertOk(await registry.deprecate(req.id, req.version));

      const versions = await registry.versions(req.id);
      assertOk(versions);
      expect(versions.value[0]?.deprecated).toBe(true);
    });

    test("deprecating one version does not affect others", async () => {
      const registry = await createRegistry();
      const id = skillId("scoped-deprecate");
      assertOk(await registry.publish(makePublishRequest({ id, version: "1.0.0" })));
      assertOk(await registry.publish(makePublishRequest({ id, version: "2.0.0" })));

      assertOk(await registry.deprecate(id, "1.0.0"));

      const versions = await registry.versions(id);
      assertOk(versions);
      // Newest first: 2.0.0 (not deprecated), 1.0.0 (deprecated)
      expect(versions.value[0]?.version).toBe("2.0.0");
      expect(versions.value[0]?.deprecated).toBeUndefined();
      expect(versions.value[1]?.version).toBe("1.0.0");
      expect(versions.value[1]?.deprecated).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // onChange()
  // -------------------------------------------------------------------------

  describe("onChange()", () => {
    test("returns unsubscribe function", async () => {
      const registry = await createRegistry();
      if (registry.onChange === undefined) return;

      const unsubscribe = registry.onChange(() => {});
      expect(typeof unsubscribe).toBe("function");
      unsubscribe();
    });

    test("unsubscribe is idempotent", async () => {
      const registry = await createRegistry();
      if (registry.onChange === undefined) return;

      const unsubscribe = registry.onChange(() => {});
      unsubscribe();
      unsubscribe(); // Should not throw
    });

    test("listener receives published event on publish", async () => {
      const registry = await createRegistry();
      if (registry.onChange === undefined) return;

      const events: SkillRegistryChangeEvent[] = [];
      const unsubscribe = registry.onChange((event) => {
        events.push(event);
      });

      const req = makePublishRequest();
      assertOk(await registry.publish(req));
      expect(events.length).toBeGreaterThan(0);
      expect(events[0]?.kind).toBe("published");
      expect(events[0]?.skillId).toBe(req.id);
      expect(events[0]?.version).toBe(req.version);
      unsubscribe();
    });

    test("listener receives unpublished event on unpublish", async () => {
      const registry = await createRegistry();
      if (registry.onChange === undefined) return;

      const req = makePublishRequest();
      assertOk(await registry.publish(req));

      const events: SkillRegistryChangeEvent[] = [];
      const unsubscribe = registry.onChange((event) => {
        events.push(event);
      });

      assertOk(await registry.unpublish(req.id));
      expect(events.length).toBe(1);
      expect(events[0]?.kind).toBe("unpublished");
      expect(events[0]?.skillId).toBe(req.id);
      unsubscribe();
    });

    test("listener receives deprecated event on deprecate", async () => {
      const registry = await createRegistry();
      if (registry.onChange === undefined) return;

      const req = makePublishRequest();
      assertOk(await registry.publish(req));

      const events: SkillRegistryChangeEvent[] = [];
      const unsubscribe = registry.onChange((event) => {
        events.push(event);
      });

      assertOk(await registry.deprecate(req.id, req.version));
      expect(events.length).toBe(1);
      expect(events[0]?.kind).toBe("deprecated");
      expect(events[0]?.skillId).toBe(req.id);
      expect(events[0]?.version).toBe(req.version);
      unsubscribe();
    });

    test("listener stops after unsubscribe", async () => {
      const registry = await createRegistry();
      if (registry.onChange === undefined) return;

      const events: SkillRegistryChangeEvent[] = [];
      const unsubscribe = registry.onChange((event) => {
        events.push(event);
      });

      assertOk(
        await registry.publish(makePublishRequest({ id: skillId("first"), version: "1.0.0" })),
      );
      const countAfterFirst = events.length;

      unsubscribe();

      assertOk(
        await registry.publish(makePublishRequest({ id: skillId("second"), version: "1.0.0" })),
      );
      expect(events.length).toBe(countAfterFirst);
    });
  });

  // -------------------------------------------------------------------------
  // round-trip (golden path)
  // -------------------------------------------------------------------------

  describe("round-trip", () => {
    test("publish -> search -> get -> versions -> install", async () => {
      const registry = await createRegistry();
      const id = skillId("roundtrip");
      const req = makePublishRequest({
        id,
        name: "Round Trip",
        content: "# Round Trip Skill",
      });

      // 1. Publish
      const publishResult = await registry.publish(req);
      assertOk(publishResult);
      expect(publishResult.value.id).toBe(id);

      // 2. Search
      const page = await registry.search({ text: "Round Trip" });
      expect(page.items.length).toBeGreaterThanOrEqual(1);
      const found = page.items.find((i) => i.id === id);
      expect(found).toBeDefined();

      // 3. Get
      const getResult = await registry.get(id);
      assertOk(getResult);
      expect(getResult.value.name).toBe("Round Trip");

      // 4. Versions
      const versionsResult = await registry.versions(id);
      assertOk(versionsResult);
      expect(versionsResult.value.length).toBe(1);
      expect(versionsResult.value[0]?.version).toBe(req.version);

      // 5. Install
      const installResult = await registry.install(id);
      assertOk(installResult);
      expect(installResult.value.kind).toBe("skill");
      expect(installResult.value.content).toBe("# Round Trip Skill");
    });
  });
}
