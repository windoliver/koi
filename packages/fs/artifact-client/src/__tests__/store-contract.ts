/**
 * Reusable contract test suite for any ArtifactClient implementation.
 *
 * Call `runArtifactStoreContractTests(factory)` with a factory that creates
 * a fresh store per test group.
 */

import { describe, expect, test } from "bun:test";
import type { ArtifactClient } from "../client.js";
import { computeContentHash } from "../hash.js";
import type { Artifact } from "../types.js";
import { artifactId } from "../types.js";

function makeArtifact(overrides: Partial<Artifact> & { readonly id: Artifact["id"] }): Artifact {
  return {
    name: "test-artifact",
    description: "A test artifact",
    content: '{"hello":"world"}',
    contentType: "application/json",
    sizeBytes: new TextEncoder().encode('{"hello":"world"}').byteLength,
    tags: ["test"],
    metadata: {},
    createdBy: "test-agent",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

export function runArtifactStoreContractTests(createStore: () => ArtifactClient): void {
  // -----------------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------------
  describe("CRUD", () => {
    test("save and load round-trip", async () => {
      const store = createStore();
      const artifact = makeArtifact({ id: artifactId("crud-1") });
      const saveResult = await store.save(artifact);
      expect(saveResult.ok).toBe(true);

      const loadResult = await store.load(artifactId("crud-1"));
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.id).toBe(artifactId("crud-1"));
        expect(loadResult.value.name).toBe("test-artifact");
        expect(loadResult.value.content).toBe('{"hello":"world"}');
      }
    });

    test("save with content hash verification", async () => {
      const store = createStore();
      const content = "hash-me-please";
      const hash = computeContentHash(content);
      const artifact = makeArtifact({
        id: artifactId("crud-hash"),
        content,
        contentHash: hash,
        sizeBytes: new TextEncoder().encode(content).byteLength,
      });

      await store.save(artifact);
      const loadResult = await store.load(artifactId("crud-hash"));
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.contentHash).toBe(hash);
      }
    });

    test("load returns NOT_FOUND for missing ID", async () => {
      const store = createStore();
      const result = await store.load(artifactId("nonexistent"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    test("update modifies fields", async () => {
      const store = createStore();
      const artifact = makeArtifact({ id: artifactId("crud-update") });
      await store.save(artifact);

      const updateResult = await store.update(artifactId("crud-update"), {
        name: "updated-name",
        description: "updated-desc",
      });
      expect(updateResult.ok).toBe(true);

      const loadResult = await store.load(artifactId("crud-update"));
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.name).toBe("updated-name");
        expect(loadResult.value.description).toBe("updated-desc");
      }
    });

    test("update returns NOT_FOUND for missing ID", async () => {
      const store = createStore();
      const result = await store.update(artifactId("nonexistent"), { name: "foo" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    test("remove deletes artifact", async () => {
      const store = createStore();
      const artifact = makeArtifact({ id: artifactId("crud-remove") });
      await store.save(artifact);

      const removeResult = await store.remove(artifactId("crud-remove"));
      expect(removeResult.ok).toBe(true);

      const loadResult = await store.load(artifactId("crud-remove"));
      expect(loadResult.ok).toBe(false);
    });

    test("remove returns NOT_FOUND for missing ID", async () => {
      const store = createStore();
      const result = await store.remove(artifactId("nonexistent"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    test("save duplicate ID returns CONFLICT", async () => {
      const store = createStore();
      const artifact = makeArtifact({ id: artifactId("crud-dup") });
      await store.save(artifact);

      const dupeResult = await store.save(artifact);
      expect(dupeResult.ok).toBe(false);
      if (!dupeResult.ok) {
        expect(dupeResult.error.code).toBe("CONFLICT");
      }
    });
  });

  // -----------------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------------
  describe("search", () => {
    function seedStore(store: ArtifactClient): Promise<readonly Artifact[]> {
      const now = Date.now();
      const artifacts: readonly Artifact[] = [
        makeArtifact({
          id: artifactId("s-1"),
          name: "alpha-tool",
          description: "first tool",
          tags: ["forge", "tool"],
          createdBy: "agent-a",
          contentType: "application/json",
          createdAt: now - 3000,
          updatedAt: now - 3000,
        }),
        makeArtifact({
          id: artifactId("s-2"),
          name: "beta-skill",
          description: "second skill",
          tags: ["forge", "skill"],
          createdBy: "agent-b",
          contentType: "text/markdown",
          createdAt: now - 2000,
          updatedAt: now - 1000,
        }),
        makeArtifact({
          id: artifactId("s-3"),
          name: "gamma-tool",
          description: "third tool for testing",
          tags: ["forge", "tool", "test"],
          createdBy: "agent-a",
          contentType: "application/json",
          createdAt: now - 1000,
          updatedAt: now - 2000,
        }),
      ];
      return Promise.all(artifacts.map((a) => store.save(a))).then(() => artifacts);
    }

    test("empty query returns all artifacts", async () => {
      const store = createStore();
      await seedStore(store);
      const result = await store.search({});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items.length).toBe(3);
        expect(result.value.total).toBe(3);
      }
    });

    test("filter by tags (AND match)", async () => {
      const store = createStore();
      await seedStore(store);
      const result = await store.search({ tags: ["forge", "tool"] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items.length).toBe(2);
        for (const item of result.value.items) {
          expect(item.tags).toContain("forge");
          expect(item.tags).toContain("tool");
        }
      }
    });

    test("filter by createdBy", async () => {
      const store = createStore();
      await seedStore(store);
      const result = await store.search({ createdBy: "agent-b" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items.length).toBe(1);
        expect(result.value.items[0]?.id).toBe(artifactId("s-2"));
      }
    });

    test("filter by contentType", async () => {
      const store = createStore();
      await seedStore(store);
      const result = await store.search({ contentType: "text/markdown" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items.length).toBe(1);
        expect(result.value.items[0]?.id).toBe(artifactId("s-2"));
      }
    });

    test("text search on name", async () => {
      const store = createStore();
      await seedStore(store);
      const result = await store.search({ textSearch: "alpha" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items.length).toBe(1);
        expect(result.value.items[0]?.name).toBe("alpha-tool");
      }
    });

    test("text search on description", async () => {
      const store = createStore();
      await seedStore(store);
      const result = await store.search({ textSearch: "testing" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items.length).toBe(1);
        expect(result.value.items[0]?.id).toBe(artifactId("s-3"));
      }
    });

    test("combined filters narrow results", async () => {
      const store = createStore();
      await seedStore(store);
      const result = await store.search({
        tags: ["forge", "tool"],
        createdBy: "agent-a",
        contentType: "application/json",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items.length).toBe(2);
      }
    });

    test("pagination with limit and offset", async () => {
      const store = createStore();
      await seedStore(store);
      const result = await store.search({ limit: 1, offset: 1, sortBy: "name", sortOrder: "asc" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items.length).toBe(1);
        expect(result.value.items[0]?.name).toBe("beta-skill");
        expect(result.value.total).toBe(3);
        expect(result.value.offset).toBe(1);
        expect(result.value.limit).toBe(1);
      }
    });

    test("sort by createdAt desc (default)", async () => {
      const store = createStore();
      await seedStore(store);
      const result = await store.search({});
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Default: createdAt desc → most recent first
        expect(result.value.items[0]?.id).toBe(artifactId("s-3"));
        expect(result.value.items[2]?.id).toBe(artifactId("s-1"));
      }
    });

    test("sort by name asc", async () => {
      const store = createStore();
      await seedStore(store);
      const result = await store.search({ sortBy: "name", sortOrder: "asc" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items[0]?.name).toBe("alpha-tool");
        expect(result.value.items[1]?.name).toBe("beta-skill");
        expect(result.value.items[2]?.name).toBe("gamma-tool");
      }
    });

    test("search with no results", async () => {
      const store = createStore();
      await seedStore(store);
      const result = await store.search({ tags: ["nonexistent-tag"] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items.length).toBe(0);
        expect(result.value.total).toBe(0);
      }
    });

    test("search with limit=0 returns empty", async () => {
      const store = createStore();
      await seedStore(store);
      const result = await store.search({ limit: 0 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items.length).toBe(0);
        expect(result.value.total).toBe(3);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------
  describe("error handling", () => {
    test("load NOT_FOUND returns error with code", async () => {
      const store = createStore();
      const result = await store.load(artifactId("missing"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
        expect(result.error.retryable).toBe(false);
      }
    });

    test("save CONFLICT returns error with code", async () => {
      const store = createStore();
      await store.save(makeArtifact({ id: artifactId("conflict-test") }));
      const result = await store.save(makeArtifact({ id: artifactId("conflict-test") }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CONFLICT");
      }
    });

    test("VALIDATION on empty ID for save", async () => {
      const store = createStore();
      const result = await store.save(makeArtifact({ id: artifactId("") }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });

    test("VALIDATION on empty ID for load", async () => {
      const store = createStore();
      const result = await store.load(artifactId(""));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });

    test("VALIDATION on negative limit", async () => {
      const store = createStore();
      const result = await store.search({ limit: -1 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });

    test("VALIDATION on negative offset", async () => {
      const store = createStore();
      const result = await store.search({ offset: -1 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });

    test("VALIDATION on empty ID for remove", async () => {
      const store = createStore();
      const result = await store.remove(artifactId(""));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });

    test("VALIDATION on empty ID for update", async () => {
      const store = createStore();
      const result = await store.update(artifactId(""), { name: "foo" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
      }
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe("edge cases", () => {
    test("empty content", async () => {
      const store = createStore();
      const artifact = makeArtifact({
        id: artifactId("edge-empty"),
        content: "",
        sizeBytes: 0,
      });
      await store.save(artifact);
      const loadResult = await store.load(artifactId("edge-empty"));
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.content).toBe("");
      }
    });

    test("unicode in names", async () => {
      const store = createStore();
      const artifact = makeArtifact({
        id: artifactId("edge-unicode"),
        name: "工具-名前-도구",
        description: "Beschreibung mit Ümlauten",
      });
      await store.save(artifact);
      const loadResult = await store.load(artifactId("edge-unicode"));
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.name).toBe("工具-名前-도구");
      }
    });

    test("many tags", async () => {
      const store = createStore();
      const tags = Array.from({ length: 50 }, (_, i) => `tag-${i}`);
      const artifact = makeArtifact({ id: artifactId("edge-tags"), tags });
      await store.save(artifact);
      const loadResult = await store.load(artifactId("edge-tags"));
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.tags.length).toBe(50);
      }
    });

    test("empty tags array", async () => {
      const store = createStore();
      const artifact = makeArtifact({ id: artifactId("edge-no-tags"), tags: [] });
      await store.save(artifact);
      const result = await store.search({ tags: [] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items.length).toBeGreaterThanOrEqual(1);
      }
    });

    test("large metadata", async () => {
      const store = createStore();
      const metadata: Record<string, unknown> = {};
      for (let i = 0; i < 100; i++) {
        metadata[`key-${i}`] = `value-${i}`;
      }
      const artifact = makeArtifact({ id: artifactId("edge-meta"), metadata });
      await store.save(artifact);
      const loadResult = await store.load(artifactId("edge-meta"));
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(Object.keys(loadResult.value.metadata).length).toBe(100);
      }
    });

    test("update only tags does not change content", async () => {
      const store = createStore();
      const artifact = makeArtifact({ id: artifactId("edge-tag-update"), content: "original" });
      await store.save(artifact);

      await store.update(artifactId("edge-tag-update"), { tags: ["new-tag"] });

      const loadResult = await store.load(artifactId("edge-tag-update"));
      expect(loadResult.ok).toBe(true);
      if (loadResult.ok) {
        expect(loadResult.value.content).toBe("original");
        expect(loadResult.value.tags).toContain("new-tag");
      }
    });

    test("exists returns true for saved artifact and false for missing", async () => {
      const store = createStore();
      const falseResult = await store.exists(artifactId("edge-exists"));
      expect(falseResult.ok).toBe(true);
      if (falseResult.ok) {
        expect(falseResult.value).toBe(false);
      }

      await store.save(makeArtifact({ id: artifactId("edge-exists") }));

      const trueResult = await store.exists(artifactId("edge-exists"));
      expect(trueResult.ok).toBe(true);
      if (trueResult.ok) {
        expect(trueResult.value).toBe(true);
      }
    });
  });
}
