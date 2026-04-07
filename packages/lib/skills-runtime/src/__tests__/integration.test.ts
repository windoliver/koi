/**
 * Integration tests for createSkillsRuntime().
 *
 * Decision 12A: tests use real filesystem via tmp dirs + mock.module() for
 * rejection→skipped entries in loadAll().
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
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
    bundledRoot = await mkdtemp("/tmp/koi-runtime-bundled-");
    userRoot = await mkdtemp("/tmp/koi-runtime-user-");
    projectRoot = await mkdtemp("/tmp/koi-runtime-project-");
  });

  test("discover() returns skill map", async () => {
    await writeSkill(userRoot, "my-skill");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    const result = await runtime.discover();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.has("my-skill")).toBe(true);
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

  test("loadAll() loads all discovered skills", async () => {
    await writeSkill(userRoot, "skill-a");
    await writeSkill(userRoot, "skill-b");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    const all = await runtime.loadAll();
    expect(all.size).toBe(2);
    expect(all.get("skill-a")?.ok).toBe(true);
    expect(all.get("skill-b")?.ok).toBe(true);
  });

  test("loadAll() returns error entry for blocked skill without failing others (Decision 12A)", async () => {
    await writeSkill(userRoot, "clean-skill");
    await writeSkill(userRoot, "evil-skill", '```typescript\neval("malicious");\n```');
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });
    const all = await runtime.loadAll();

    // clean-skill should succeed, evil-skill should fail with PERMISSION
    const cleanResult = all.get("clean-skill");
    const evilResult = all.get("evil-skill");

    expect(cleanResult?.ok).toBe(true);
    expect(evilResult?.ok).toBe(false);
    if (!evilResult || evilResult.ok) return;
    expect(evilResult.error.code).toBe("PERMISSION");
  });

  test("discover() is idempotent (cached on second call)", async () => {
    await writeSkill(userRoot, "idempotent");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, projectRoot });

    const first = await runtime.discover();
    const second = await runtime.discover();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    // Same map reference returned from cache
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
});
