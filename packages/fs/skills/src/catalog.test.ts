import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { discoverSkillCatalogEntries, mapSkillToCatalogEntry } from "./catalog.js";
import type { SkillMetadataEntry } from "./types.js";

// ---------------------------------------------------------------------------
// mapSkillToCatalogEntry
// ---------------------------------------------------------------------------

describe("mapSkillToCatalogEntry", () => {
  test("maps metadata entry to CatalogEntry with bundled source", () => {
    const entry: SkillMetadataEntry = {
      level: "metadata",
      name: "code-review",
      description: "Reviews code for quality",
      dirPath: "/skills/code-review",
    };

    const result = mapSkillToCatalogEntry(entry);

    expect(result).toEqual({
      name: "bundled:code-review",
      kind: "skill",
      source: "bundled",
      description: "Reviews code for quality",
    });
  });

  test("includes allowedTools as tags when present", () => {
    const entry: SkillMetadataEntry = {
      level: "metadata",
      name: "code-review",
      description: "Reviews code",
      dirPath: "/skills/code-review",
      allowedTools: ["read_file", "write_file"],
    };

    const result = mapSkillToCatalogEntry(entry);

    expect(result.tags).toEqual(["read_file", "write_file"]);
  });

  test("omits tags when allowedTools is empty", () => {
    const entry: SkillMetadataEntry = {
      level: "metadata",
      name: "minimal",
      description: "Minimal skill",
      dirPath: "/skills/minimal",
      allowedTools: [],
    };

    const result = mapSkillToCatalogEntry(entry);

    expect(result.tags).toBeUndefined();
  });

  test("omits tags when allowedTools is undefined", () => {
    const entry: SkillMetadataEntry = {
      level: "metadata",
      name: "minimal",
      description: "Minimal skill",
      dirPath: "/skills/minimal",
    };

    const result = mapSkillToCatalogEntry(entry);

    expect(result.tags).toBeUndefined();
  });

  test("always sets kind to skill", () => {
    const entry: SkillMetadataEntry = {
      level: "metadata",
      name: "any-skill",
      description: "Any skill",
      dirPath: "/skills/any",
    };

    const result = mapSkillToCatalogEntry(entry);

    expect(result.kind).toBe("skill");
    expect(result.source).toBe("bundled");
  });
});

// ---------------------------------------------------------------------------
// discoverSkillCatalogEntries
// ---------------------------------------------------------------------------

describe("discoverSkillCatalogEntries", () => {
  const fixturesDir = join(import.meta.dir, "..", "fixtures");

  test("discovers valid skills and returns CatalogEntry array", async () => {
    const result = await discoverSkillCatalogEntries(fixturesDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should find valid-skill and minimal-skill (invalid-name and no-frontmatter fail to load)
    const names = result.value.map((e) => e.name);
    expect(names).toContain("bundled:code-review");
    expect(names).toContain("bundled:minimal");
  });

  test("all returned entries have source bundled and kind skill", async () => {
    const result = await discoverSkillCatalogEntries(fixturesDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const entry of result.value) {
      expect(entry.source).toBe("bundled");
      expect(entry.kind).toBe("skill");
      expect(entry.name.startsWith("bundled:")).toBe(true);
    }
  });

  test("skips skills that fail to load (partial success)", async () => {
    const result = await discoverSkillCatalogEntries(fixturesDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // invalid-name and no-frontmatter fixtures should be skipped, not error
    const names = result.value.map((e) => e.name);
    expect(names).not.toContain("bundled:Invalid-Name");
    expect(names).not.toContain("bundled:no-frontmatter");
  });

  test("returns error when base path does not exist", async () => {
    const result = await discoverSkillCatalogEntries("/nonexistent/path");

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("returns empty array when no skills found", async () => {
    // Use a directory that exists but has no SKILL.md subdirectories
    const result = await discoverSkillCatalogEntries(join(fixturesDir, "valid-skill", "scripts"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toEqual([]);
  });

  test("includes tags from allowedTools in discovered entries", async () => {
    const result = await discoverSkillCatalogEntries(fixturesDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const codeReview = result.value.find((e) => e.name === "bundled:code-review");
    expect(codeReview).toBeDefined();
    expect(codeReview?.tags).toEqual(["read_file", "write_file", "search"]);
  });
});
