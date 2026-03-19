import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  discoverSkillDirs,
  loadSkill,
  loadSkillBody,
  loadSkillBundled,
  loadSkillMetadata,
} from "./loader.js";

const FIXTURES = resolve(import.meta.dir, "../fixtures");

describe("loadSkillMetadata", () => {
  test("loads valid skill metadata from fixture", async () => {
    const result = await loadSkillMetadata(resolve(FIXTURES, "valid-skill"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.level).toBe("metadata");
      expect(result.value.name).toBe("code-review");
      expect(result.value.description).toContain("Reviews code");
      expect(result.value.license).toBe("MIT");
      expect(result.value.allowedTools).toEqual(["read_file", "write_file", "search"]);
    }
  });

  test("loads minimal skill metadata", async () => {
    const result = await loadSkillMetadata(resolve(FIXTURES, "minimal-skill"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.level).toBe("metadata");
      expect(result.value.name).toBe("minimal");
      expect("license" in result.value).toBe(false);
    }
  });

  test("returns error for missing SKILL.md", async () => {
    const result = await loadSkillMetadata("/tmp/does-not-exist-koi-test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("returns validation error for invalid name", async () => {
    const result = await loadSkillMetadata(resolve(FIXTURES, "invalid-name"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("returns parse error for no frontmatter", async () => {
    const result = await loadSkillMetadata(resolve(FIXTURES, "no-frontmatter"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });
});

describe("loadSkillBody", () => {
  test("loads skill with body content", async () => {
    const result = await loadSkillBody(resolve(FIXTURES, "valid-skill"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.level).toBe("body");
      expect(result.value.body).toContain("# Code Review Skill");
      expect(result.value.body).toContain("```javascript");
    }
  });

  test("loads minimal skill with body", async () => {
    const result = await loadSkillBody(resolve(FIXTURES, "minimal-skill"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.level).toBe("body");
      expect(result.value.body).toBe("Minimal body.");
    }
  });
});

describe("loadSkillBundled", () => {
  test("loads skill with scripts, references, and assets", async () => {
    const result = await loadSkillBundled(resolve(FIXTURES, "valid-skill"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.level).toBe("bundled");
      expect(result.value.scripts.length).toBeGreaterThanOrEqual(1);
      expect(result.value.scripts.some((s) => s.filename === "helper.sh")).toBe(true);
      expect(result.value.references.length).toBeGreaterThanOrEqual(1);
      expect(result.value.references.some((r) => r.filename === "example.md")).toBe(true);
      expect(result.value.assets.length).toBeGreaterThanOrEqual(1);
      expect(result.value.assets.some((a) => a.filename === "report-template.md")).toBe(true);
    }
  });

  test("returns empty scripts/references/assets when directories missing", async () => {
    const result = await loadSkillBundled(resolve(FIXTURES, "minimal-skill"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.level).toBe("bundled");
      expect(result.value.scripts).toHaveLength(0);
      expect(result.value.references).toHaveLength(0);
      expect(result.value.assets).toHaveLength(0);
    }
  });
});

describe("loadSkill", () => {
  test("dispatches to metadata level", async () => {
    const result = await loadSkill(resolve(FIXTURES, "valid-skill"), "metadata");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.level).toBe("metadata");
    }
  });

  test("dispatches to body level (default)", async () => {
    const result = await loadSkill(resolve(FIXTURES, "valid-skill"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.level).toBe("body");
    }
  });

  test("dispatches to bundled level", async () => {
    const result = await loadSkill(resolve(FIXTURES, "valid-skill"), "bundled");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.level).toBe("bundled");
    }
  });
});

describe("discoverSkillDirs", () => {
  test("discovers skill directories under fixtures", async () => {
    const result = await discoverSkillDirs(FIXTURES);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBeGreaterThanOrEqual(3);
      const names = result.value.map((d) => d.split("/").pop());
      expect(names).toContain("valid-skill");
      expect(names).toContain("minimal-skill");
      expect(names).toContain("invalid-name");
    }
  });

  test("returns error for non-existent directory", async () => {
    const result = await discoverSkillDirs("/tmp/does-not-exist-koi-test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });
});
