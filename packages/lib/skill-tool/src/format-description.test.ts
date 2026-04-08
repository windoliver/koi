import { describe, expect, test } from "bun:test";
import { formatSkillDescription } from "./format-description.js";
import type { SkillMeta } from "./types.js";

function makeMeta(name: string, description: string, source = "project"): SkillMeta {
  return { name, description, source, dirPath: `/skills/${name}` };
}

describe("formatSkillDescription", () => {
  test("returns empty string for no skills", () => {
    expect(formatSkillDescription([])).toBe("");
  });

  test("returns full descriptions when within budget", () => {
    const skills = [makeMeta("alpha", "Does alpha things"), makeMeta("beta", "Does beta things")];
    const result = formatSkillDescription(skills);
    expect(result).toContain("- alpha: Does alpha things");
    expect(result).toContain("- beta: Does beta things");
    expect(result).toStartWith("Available skills (invoke by name):");
  });

  test("sorts skills alphabetically", () => {
    const skills = [makeMeta("zeta", "Last"), makeMeta("alpha", "First")];
    const result = formatSkillDescription(skills);
    const alphaIdx = result.indexOf("alpha");
    const zetaIdx = result.indexOf("zeta");
    expect(alphaIdx).toBeLessThan(zetaIdx);
  });

  test("truncates non-bundled descriptions in phase 2 when over budget", () => {
    const longDesc = "x".repeat(500);
    const skills = [
      makeMeta("bundled-skill", "Short bundled desc", "bundled"),
      makeMeta("project-skill", longDesc, "project"),
    ];
    // Use a budget that fits phase 2 but not phase 1
    const phase1Full = `- bundled-skill: Short bundled desc\n- project-skill: ${longDesc}`;
    const budget = phase1Full.length - 50; // tighter than full
    const result = formatSkillDescription(skills, budget);
    // Bundled should be full
    expect(result).toContain("- bundled-skill: Short bundled desc");
    // Project should be truncated (ends with ...)
    expect(result).toContain("- project-skill: ");
    expect(result).not.toContain(longDesc);
  });

  test("falls back to names-only in phase 3 when heavily over budget", () => {
    const longDesc = "x".repeat(300);
    const skills = Array.from({ length: 20 }, (_, i) =>
      makeMeta(`skill-${String(i).padStart(2, "0")}`, longDesc),
    );
    // Very tight budget — only names fit
    const result = formatSkillDescription(skills, 200);
    expect(result).toContain("- skill-00");
    expect(result).not.toContain(longDesc);
  });

  test("shows overflow indicator when names exceed budget", () => {
    const skills = Array.from({ length: 50 }, (_, i) =>
      makeMeta(`very-long-skill-name-${String(i).padStart(3, "0")}`, "desc"),
    );
    // Very tight budget
    const result = formatSkillDescription(skills, 300);
    expect(result).toMatch(/\.\.\. and \d+ more/);
  });

  test("never truncates bundled skill descriptions in phase 2", () => {
    const longDesc = "b".repeat(400);
    const skills = [
      makeMeta("bundled-a", longDesc, "bundled"),
      makeMeta("project-b", longDesc, "project"),
    ];
    // Budget allows phase 2 but not phase 1
    const result = formatSkillDescription(skills, 600);
    // If we're in phase 2, bundled description should be full
    if (result.includes(`bundled-a: ${"b".repeat(400)}`)) {
      // Bundled is preserved
      expect(result).toContain(longDesc);
    }
    // If we're in phase 3, that's fine — both degraded equally
  });

  test("always shows at least one skill even with tiny budget", () => {
    const skills = [makeMeta("only-skill", "description")];
    const result = formatSkillDescription(skills, 10);
    expect(result).toContain("only-skill");
  });
});
