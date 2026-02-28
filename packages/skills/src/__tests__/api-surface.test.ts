import { describe, expect, test } from "bun:test";
import * as skills from "../index.js";

describe("@koi/skills API surface", () => {
  test("exports parseSkillMd function", () => {
    expect(typeof skills.parseSkillMd).toBe("function");
  });

  test("exports validateSkillFrontmatter function", () => {
    expect(typeof skills.validateSkillFrontmatter).toBe("function");
  });

  test("exports loader functions", () => {
    expect(typeof skills.loadSkillMetadata).toBe("function");
    expect(typeof skills.loadSkillBody).toBe("function");
    expect(typeof skills.loadSkillBundled).toBe("function");
    expect(typeof skills.loadSkill).toBe("function");
    expect(typeof skills.discoverSkillDirs).toBe("function");
  });

  test("exports createSkillComponentProvider factory", () => {
    expect(typeof skills.createSkillComponentProvider).toBe("function");
  });

  test("exports catalog integration functions", () => {
    expect(typeof skills.mapSkillToCatalogEntry).toBe("function");
    expect(typeof skills.discoverSkillCatalogEntries).toBe("function");
  });

  test("exports createSkillActivatorMiddleware factory", () => {
    expect(typeof skills.createSkillActivatorMiddleware).toBe("function");
  });

  test("exports progressive loading utilities", () => {
    expect(typeof skills.isAtOrAbove).toBe("function");
    expect(typeof skills.LEVEL_ORDER).toBe("object");
    expect(skills.LEVEL_ORDER.metadata).toBe(0);
    expect(skills.LEVEL_ORDER.body).toBe(1);
    expect(skills.LEVEL_ORDER.bundled).toBe(2);
  });
});
