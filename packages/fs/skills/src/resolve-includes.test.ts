import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveIncludes } from "./resolve-includes.js";

/** Creates a file inside the temp directory using Bun.write (auto-creates parents). */
async function writeFile(dir: string, relativePath: string, content: string): Promise<void> {
  await Bun.write(join(dir, relativePath), content);
}

/** Creates a minimal SKILL.md frontmatter with optional includes. */
function skillMd(includes?: readonly string[]): string {
  const includesLine =
    includes !== undefined && includes.length > 0
      ? `includes:\n${includes.map((i) => `  - "${i}"`).join("\n")}\n`
      : "";
  return `---\nname: test-skill\ndescription: A test skill\n${includesLine}---\n# Test\n`;
}

describe("resolveIncludes", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "koi-includes-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("resolves single include at depth 1", async () => {
    const skillDir = join(tempDir, "skill-a");
    await writeFile(skillDir, "SKILL.md", skillMd(["./doc.md"]));
    await writeFile(skillDir, "doc.md", "# Documentation\nSome helpful content.");

    const result = await resolveIncludes(["./doc.md"], skillDir, { skillsRoot: tempDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.content).toBe("# Documentation\nSome helpful content.");
    }
  });

  test("handles direct cycle (A includes B, B includes A)", async () => {
    const skillDir = join(tempDir, "skill-a");
    await writeFile(skillDir, "SKILL.md", skillMd(["./b.md"]));
    await writeFile(
      skillDir,
      "b.md",
      `---\nname: b\ndescription: B\nincludes:\n  - "./SKILL.md"\n---\n# B content`,
    );

    const result = await resolveIncludes(["./b.md"], skillDir, { skillsRoot: tempDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // B is included, A (SKILL.md) is skipped because it's in the visited set
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.content).toContain("# B content");
    }
  });

  test("handles transitive cycle (A→B→C→A)", async () => {
    const dirA = join(tempDir, "a");
    const dirB = join(tempDir, "b");
    const dirC = join(tempDir, "c");

    await writeFile(dirA, "SKILL.md", skillMd(["../b/doc.md"]));
    await writeFile(
      dirB,
      "doc.md",
      `---\nname: b\ndescription: B\nincludes:\n  - "../c/doc.md"\n---\n# B`,
    );
    await writeFile(
      dirC,
      "doc.md",
      `---\nname: c\ndescription: C\nincludes:\n  - "../a/SKILL.md"\n---\n# C`,
    );

    const result = await resolveIncludes(["../b/doc.md"], dirA, { skillsRoot: tempDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // B and C resolved, A skipped (in visited set from initialization)
      expect(result.value).toHaveLength(2);
      expect(result.value[0]?.content).toContain("# B");
      expect(result.value[1]?.content).toContain("# C");
    }
  });

  test("deduplicates diamond dependency (A→B, A→C, B→D, C→D)", async () => {
    const dir = join(tempDir, "skills");
    await writeFile(dir, "SKILL.md", skillMd(["./b.md", "./c.md"]));
    await writeFile(dir, "b.md", `---\nname: b\ndescription: B\nincludes:\n  - "./d.md"\n---\n# B`);
    await writeFile(dir, "c.md", `---\nname: c\ndescription: C\nincludes:\n  - "./d.md"\n---\n# C`);
    await writeFile(dir, "d.md", "# Shared D content");

    const result = await resolveIncludes(["./b.md", "./c.md"], dir, { skillsRoot: tempDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // B, D (from B's includes), C — D not duplicated from C's includes
      expect(result.value).toHaveLength(3);
      const paths = result.value.map((r) => r.path);
      const dOccurrences = paths.filter((p) => p.endsWith("d.md")).length;
      expect(dOccurrences).toBe(1);
    }
  });

  test("succeeds at max depth (depth 3)", async () => {
    const dir = join(tempDir, "deep");
    // A → B → C → D (3 levels of nesting, at the limit)
    await writeFile(dir, "SKILL.md", skillMd(["./b.md"]));
    await writeFile(dir, "b.md", `---\nname: b\ndescription: B\nincludes:\n  - "./c.md"\n---\n# B`);
    await writeFile(dir, "c.md", `---\nname: c\ndescription: C\nincludes:\n  - "./d.md"\n---\n# C`);
    await writeFile(dir, "d.md", "# D — leaf node");

    const result = await resolveIncludes(["./b.md"], dir, {
      skillsRoot: tempDir,
      maxDepth: 3,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(3);
    }
  });

  test("returns error when depth exceeded", async () => {
    const dir = join(tempDir, "too-deep");
    // A → B → C → D → E (4 levels, exceeds maxDepth=3)
    await writeFile(dir, "SKILL.md", skillMd(["./b.md"]));
    await writeFile(dir, "b.md", `---\nname: b\ndescription: B\nincludes:\n  - "./c.md"\n---\n# B`);
    await writeFile(dir, "c.md", `---\nname: c\ndescription: C\nincludes:\n  - "./d.md"\n---\n# C`);
    await writeFile(dir, "d.md", `---\nname: d\ndescription: D\nincludes:\n  - "./e.md"\n---\n# D`);
    await writeFile(dir, "e.md", "# E — too deep");

    const result = await resolveIncludes(["./b.md"], dir, {
      skillsRoot: tempDir,
      maxDepth: 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("depth exceeded");
      expect(result.error.context).toHaveProperty("errorKind", "INCLUDE_DEPTH_EXCEEDED");
    }
  });

  test("returns error for nonexistent include", async () => {
    const dir = join(tempDir, "missing");
    await writeFile(dir, "SKILL.md", skillMd(["./nonexistent.md"]));

    const result = await resolveIncludes(["./nonexistent.md"], dir, { skillsRoot: tempDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.context).toHaveProperty("errorKind", "INCLUDE_NOT_FOUND");
    }
  });

  test("returns error for path traversal outside skillsRoot", async () => {
    // Create a file outside skillsRoot but inside tempDir
    const skillsRoot = join(tempDir, "skills");
    const skillDir = join(skillsRoot, "my-skill");
    await writeFile(skillDir, "SKILL.md", skillMd(["../../secret.env"]));
    await writeFile(tempDir, "secret.env", "SECRET=leaked");

    const result = await resolveIncludes(["../../secret.env"], skillDir, { skillsRoot });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.context).toHaveProperty("errorKind", "INCLUDE_PATH_VIOLATION");
    }
  });
});
