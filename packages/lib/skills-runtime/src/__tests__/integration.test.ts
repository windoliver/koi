/**
 * Integration tests for createSkillsRuntime().
 *
 * Issue 12A: afterEach cleanup + os.tmpdir() instead of hardcoded /tmp.
 * Issue 2A: concurrent load deduplication tests.
 * Issue 3A: loadAll() returns Result<Map, KoiError>.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillsRuntime } from "../index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeSkill(root: string, name: string, extra = ""): Promise<void> {
  const content = `---\nname: ${name}\ndescription: Test ${name}.\n---\n\n# ${name}\n\n${extra}`;
  await Bun.write(join(root, name, "SKILL.md"), content, { createPath: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSkillsRuntime — integration", () => {
  let bundledRoot: string;
  let userRoot: string;
  let projectRoot: string;

  beforeEach(async () => {
    bundledRoot = await mkdtemp(join(tmpdir(), "koi-runtime-bundled-"));
    userRoot = await mkdtemp(join(tmpdir(), "koi-runtime-user-"));
    projectRoot = await mkdtemp(join(tmpdir(), "koi-runtime-project-"));
  });

  afterEach(async () => {
    await rm(bundledRoot, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  test("discover() returns skill metadata map with description", async () => {
    await writeSkill(userRoot, "my-skill");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    const result = await runtime.discover();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.has("my-skill")).toBe(true);
    expect(result.value.get("my-skill")?.source).toBe("user");
    expect(result.value.get("my-skill")?.description).toBe("Test my-skill.");
  });

  test("load() loads a known skill after discover()", async () => {
    await writeSkill(userRoot, "load-me");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    await runtime.discover();
    const result = await runtime.load("load-me");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe("load-me");
    expect(result.value.source).toBe("user");
  });

  test("load() auto-discovers before loading", async () => {
    await writeSkill(bundledRoot, "auto-discover");
    const runtime = createSkillsRuntime({ bundledRoot, userRoot, projectRoot });
    // No explicit discover() call
    const result = await runtime.load("auto-discover");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe("auto-discover");
  });

  test("load() returns NOT_FOUND for unknown skill", async () => {
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    const result = await runtime.load("does-not-exist");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  test("loadAll() loads all discovered skills — returns outer Result", async () => {
    await writeSkill(userRoot, "skill-a");
    await writeSkill(userRoot, "skill-b");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    const allResult = await runtime.loadAll();
    expect(allResult.ok).toBe(true);
    if (!allResult.ok) return;
    expect(allResult.value.size).toBe(2);
    expect(allResult.value.get("skill-a")?.ok).toBe(true);
    expect(allResult.value.get("skill-b")?.ok).toBe(true);
  });

  test("loadAll() returns per-skill error for blocked skill without failing others", async () => {
    await writeSkill(userRoot, "clean-skill");
    await writeSkill(userRoot, "evil-skill", '```typescript\neval("malicious");\n```');
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    const allResult = await runtime.loadAll();

    expect(allResult.ok).toBe(true);
    if (!allResult.ok) return;

    const cleanResult = allResult.value.get("clean-skill");
    const evilResult = allResult.value.get("evil-skill");

    expect(cleanResult?.ok).toBe(true);
    expect(evilResult?.ok).toBe(false);
    if (!evilResult || evilResult.ok) return;
    expect(evilResult.error.code).toBe("PERMISSION");
  });

  test("discover() is idempotent — same map reference returned on second call", async () => {
    await writeSkill(userRoot, "idempotent");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });

    const first = await runtime.discover();
    const second = await runtime.discover();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    // Same map reference returned from cache (reference identity preserved)
    expect(second.value).toBe(first.value);
  });

  test("respects onShadowedSkill callback", async () => {
    await writeSkill(bundledRoot, "shared");
    await writeSkill(projectRoot, "shared");
    const shadowedNames: string[] = [];
    const runtime = createSkillsRuntime({
      bundledRoot,
      userRoot,
      projectRoot,
      onShadowedSkill: (name) => {
        shadowedNames.push(name);
      },
    });
    await runtime.discover();
    expect(shadowedNames).toContain("shared");
  });

  test("skill with allowed-tools loads correctly", async () => {
    const content = `---\nname: tool-skill\ndescription: Has tools.\nallowed-tools: read_file write_file\n---\n\nBody.`;
    await Bun.write(join(userRoot, "tool-skill", "SKILL.md"), content, { createPath: true });

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    const result = await runtime.load("tool-skill");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.allowedTools).toEqual(["read_file", "write_file"]);
  });

  test("skill with tags in frontmatter loads with tags on SkillDefinition", async () => {
    const content = `---\nname: tagged-skill\ndescription: Has tags.\ntags:\n  - typescript\n  - refactor\n---\n\nBody.`;
    await Bun.write(join(userRoot, "tagged-skill", "SKILL.md"), content, { createPath: true });

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    const result = await runtime.load("tagged-skill");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tags).toEqual(["typescript", "refactor"]);
  });

  // ---------------------------------------------------------------------------
  // Concurrent access tests (Issue 10A)
  // ---------------------------------------------------------------------------

  describe("concurrent access safety", () => {
    test("concurrent discover() calls deduplicate — same map reference", async () => {
      await writeSkill(userRoot, "concurrent-skill");
      const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });

      const [first, second] = await Promise.all([runtime.discover(), runtime.discover()]);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      // Both return the same Map reference (cached projection, deduped)
      expect(first.value).toBe(second.value);
    });

    test("concurrent load() calls for the same skill return same reference", async () => {
      await writeSkill(userRoot, "dedup-skill");
      const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });

      const [first, second] = await Promise.all([
        runtime.load("dedup-skill"),
        runtime.load("dedup-skill"),
      ]);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      // Both return the same SkillDefinition reference (from cache)
      expect(first.value).toBe(second.value);
    });

    test("third load() after concurrent dedup hits body cache directly", async () => {
      await writeSkill(userRoot, "triple-load");
      const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });

      await Promise.all([runtime.load("triple-load"), runtime.load("triple-load")]);

      const third = await runtime.load("triple-load");
      expect(third.ok).toBe(true);
      if (!third.ok) return;
      expect(third.value.name).toBe("triple-load");
    });

    test("concurrent loadAll() calls complete without error", async () => {
      await writeSkill(userRoot, "skill-a");
      await writeSkill(userRoot, "skill-b");
      const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });

      const [first, second] = await Promise.all([runtime.loadAll(), runtime.loadAll()]);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
    });
  });
});
