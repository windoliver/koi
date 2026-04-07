import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import type { Agent } from "@koi/core";
import { isAttachResult, skillToken } from "@koi/core";
import { createSkillsRuntime } from "./index.js";
import { createSkillProvider, skillDefinitionToComponent } from "./provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeSkill(root: string, name: string, body = "Body."): Promise<void> {
  const content = `---\nname: ${name}\ndescription: Test ${name}.\nallowed-tools: read_file\n---\n\n${body}`;
  await Bun.write(join(root, name, "SKILL.md"), content, { createPath: true });
}

// Stub Agent — provider.attach() receives it but doesn't read it
const STUB_AGENT = {} as Agent;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSkillProvider", () => {
  let userRoot: string;

  beforeEach(async () => {
    userRoot = await mkdtemp("/tmp/koi-provider-test-");
  });

  test("attaches loaded skills as SkillComponents under skillToken keys", async () => {
    await writeSkill(userRoot, "my-skill");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    const provider = createSkillProvider(runtime);

    expect(provider.name).toBe("skills-runtime");

    const result = await provider.attach(STUB_AGENT);
    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;

    // The skill should be attached under skillToken("my-skill")
    const token = skillToken("my-skill");
    const component = result.components.get(token);
    expect(component).toBeDefined();
    const skill = component as { name: string; description: string; content: string };
    expect(skill.name).toBe("my-skill");
    expect(skill.description).toBe("Test my-skill.");
    expect(skill.content).toContain("Body.");
  });

  test("reports blocked/failed skills as skipped entries", async () => {
    const maliciousBody = '```typescript\neval("bad");\n```';
    await writeSkill(userRoot, "evil-skill", maliciousBody);
    const runtime = createSkillsRuntime({
      bundledRoot: null,
      userRoot,
      blockOnSeverity: "HIGH",
    });
    const provider = createSkillProvider(runtime);
    const result = await provider.attach(STUB_AGENT);

    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;
    // Blocked skill reported as skipped, not attached
    const token = skillToken("evil-skill");
    expect(result.components.get(token)).toBeUndefined();
    expect(result.skipped.some((s) => s.name === "evil-skill")).toBe(true);
  });

  test("attaches multiple skills from the same runtime", async () => {
    await writeSkill(userRoot, "skill-a");
    await writeSkill(userRoot, "skill-b");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    const provider = createSkillProvider(runtime);
    const result = await provider.attach(STUB_AGENT);

    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;
    expect(result.components.has(skillToken("skill-a"))).toBe(true);
    expect(result.components.has(skillToken("skill-b"))).toBe(true);
    expect(result.skipped).toHaveLength(0);
  });

  test("returns empty components when no skills discovered", async () => {
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    const provider = createSkillProvider(runtime);
    const result = await provider.attach(STUB_AGENT);

    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;
    expect(result.components.size).toBe(0);
    expect(result.skipped).toHaveLength(0);
  });
});

describe("skillDefinitionToComponent", () => {
  test("converts SkillDefinition to SkillComponent", () => {
    const def = {
      name: "my-skill",
      description: "Does things.",
      body: "# My Skill\n\nDo this.",
      source: "user" as const,
      dirPath: "/tmp/my-skill",
    };
    const component = skillDefinitionToComponent(def);
    expect(component.name).toBe("my-skill");
    expect(component.description).toBe("Does things.");
    expect(component.content).toBe("# My Skill\n\nDo this.");
    expect(component.requires).toBeUndefined();
  });

  test("maps requires from SkillDefinition to SkillComponent", () => {
    const def = {
      name: "s",
      description: "d",
      body: "b",
      source: "bundled" as const,
      dirPath: "/tmp/s",
      requires: { bins: ["git"], env: ["TOKEN"] },
    };
    const component = skillDefinitionToComponent(def);
    expect(component.requires?.bins).toEqual(["git"]);
    expect(component.requires?.env).toEqual(["TOKEN"]);
  });
});
