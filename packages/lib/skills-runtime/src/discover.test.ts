/**
 * Discovery unit tests.
 *
 * Decision 10A: 6 precedence scenarios:
 *   1. Only bundled
 *   2. Only user
 *   3. Only project
 *   4. User shadows bundled (user wins, shadow warning fired)
 *   5. Project shadows user (project wins, shadow warning fired)
 *   6. Project shadows bundled (project wins, shadow warning fired)
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { discoverSkills } from "./discover.js";
import type { SkillSource } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeSkillDir(root: string, name: string): Promise<void> {
  const content = `---\nname: ${name}\ndescription: Test skill.\n---\n\nBody.`;
  await Bun.write(join(root, name, "SKILL.md"), content, { createPath: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("discoverSkills", () => {
  let bundledRoot: string;
  let userRoot: string;
  let projectRoot: string;

  beforeEach(async () => {
    bundledRoot = await mkdtemp("/tmp/koi-bundled-");
    userRoot = await mkdtemp("/tmp/koi-user-");
    projectRoot = await mkdtemp("/tmp/koi-project-");
  });

  // 1. Only bundled
  test("discovers bundled-only skills", async () => {
    await writeSkillDir(bundledRoot, "alpha");
    const result = await discoverSkills({ bundledRoot, userRoot, projectRoot });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skills.get("alpha")).toBe("bundled");
    expect(result.value.dirPaths.get("alpha")).toContain("alpha");
  });

  // 2. Only user
  test("discovers user-only skills", async () => {
    await writeSkillDir(userRoot, "beta");
    const result = await discoverSkills({ bundledRoot, userRoot, projectRoot });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skills.get("beta")).toBe("user");
  });

  // 3. Only project
  test("discovers project-only skills", async () => {
    await writeSkillDir(projectRoot, "gamma");
    const result = await discoverSkills({ bundledRoot, userRoot, projectRoot });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skills.get("gamma")).toBe("project");
  });

  // 4. User shadows bundled
  test("user skill shadows bundled skill of same name (Decision 4A)", async () => {
    await writeSkillDir(bundledRoot, "shared");
    await writeSkillDir(userRoot, "shared");
    const shadowedWarnings: Array<{ name: string; by: SkillSource }> = [];
    const result = await discoverSkills({
      bundledRoot,
      userRoot,
      projectRoot,
      onShadowedSkill: (name, by) => {
        shadowedWarnings.push({ name, by });
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skills.get("shared")).toBe("user");
    expect(shadowedWarnings.some((w) => w.name === "shared" && w.by === "user")).toBe(true);
  });

  // 5. Project shadows user
  test("project skill shadows user skill of same name (Decision 4A)", async () => {
    await writeSkillDir(userRoot, "shared2");
    await writeSkillDir(projectRoot, "shared2");
    const shadowedWarnings: Array<{ name: string; by: SkillSource }> = [];
    const result = await discoverSkills({
      bundledRoot,
      userRoot,
      projectRoot,
      onShadowedSkill: (name, by) => {
        shadowedWarnings.push({ name, by });
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skills.get("shared2")).toBe("project");
    expect(shadowedWarnings.some((w) => w.name === "shared2" && w.by === "project")).toBe(true);
  });

  // 6. Project shadows bundled
  test("project skill shadows bundled skill of same name", async () => {
    await writeSkillDir(bundledRoot, "shared3");
    await writeSkillDir(projectRoot, "shared3");
    const shadowedWarnings: Array<{ name: string; by: SkillSource }> = [];
    const result = await discoverSkills({
      bundledRoot,
      userRoot,
      projectRoot,
      onShadowedSkill: (name, by) => {
        shadowedWarnings.push({ name, by });
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skills.get("shared3")).toBe("project");
    expect(shadowedWarnings.length).toBeGreaterThan(0);
  });

  test("non-existent roots are silently skipped (no error)", async () => {
    const result = await discoverSkills({
      bundledRoot: "/nonexistent/bundled",
      userRoot: "/nonexistent/user",
      projectRoot: "/nonexistent/project",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skills.size).toBe(0);
  });

  test("null bundledRoot disables bundled tier", async () => {
    await writeSkillDir(bundledRoot, "alpha");
    const result = await discoverSkills({ bundledRoot: null, userRoot, projectRoot });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skills.get("alpha")).toBeUndefined();
  });

  test("discovers skills from all three tiers simultaneously", async () => {
    await writeSkillDir(bundledRoot, "only-bundled");
    await writeSkillDir(userRoot, "only-user");
    await writeSkillDir(projectRoot, "only-project");
    const result = await discoverSkills({ bundledRoot, userRoot, projectRoot });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skills.get("only-bundled")).toBe("bundled");
    expect(result.value.skills.get("only-user")).toBe("user");
    expect(result.value.skills.get("only-project")).toBe("project");
    expect(result.value.skills.size).toBe(3);
  });

  test("ignores invalid skill names (non-lowercase, numbers-only, etc.)", async () => {
    // Valid name: lowercase alphanumeric + hyphens
    await writeSkillDir(bundledRoot, "valid-name");
    // Simulate an invalid name by creating a dir with an invalid name
    // (on most filesystems these are valid directory names but invalid skill names)
    const invalidDir = join(bundledRoot, "InvalidName");
    await Bun.write(join(invalidDir, "SKILL.md"), "---\nname: x\ndescription: y\n---\n", {
      createPath: true,
    });

    const result = await discoverSkills({ bundledRoot, userRoot, projectRoot });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skills.get("valid-name")).toBe("bundled");
    expect(result.value.skills.get("InvalidName")).toBeUndefined();
  });
});
