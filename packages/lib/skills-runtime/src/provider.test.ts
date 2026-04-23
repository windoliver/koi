import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
    userRoot = await mkdtemp(join(tmpdir(), "koi-provider-test-"));
  });

  afterEach(async () => {
    await rm(userRoot, { recursive: true, force: true });
  });

  test("attaches loaded skills as SkillComponents under skillToken keys", async () => {
    await writeSkill(userRoot, "my-skill");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    const provider = createSkillProvider(runtime);

    expect(provider.name).toBe("skills-runtime");

    const result = await provider.attach(STUB_AGENT);
    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;

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
    const token = skillToken("evil-skill");
    expect(result.components.get(token)).toBeUndefined();
    expect(result.skipped.some((s: { name: string }) => s.name === "evil-skill")).toBe(true);
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

  test("preserves executionMode through conversion", () => {
    const def = {
      name: "fork-skill",
      description: "Runs in sub-agent.",
      body: "# Fork\n\nDo this in isolation.",
      source: "user" as const,
      dirPath: "/tmp/fork-skill",
      executionMode: "fork" as const,
    };
    const component = skillDefinitionToComponent(def);
    expect(component.executionMode).toBe("fork");
  });

  test("omits executionMode when undefined (inline default)", () => {
    const def = {
      name: "inline-skill",
      description: "Inline.",
      body: "b",
      source: "user" as const,
      dirPath: "/tmp/inline",
    };
    const component = skillDefinitionToComponent(def);
    expect(component.executionMode).toBeUndefined();
  });
});

describe("createSkillProvider — progressive mode", () => {
  let userRoot: string;

  beforeEach(async () => {
    userRoot = await mkdtemp(join(tmpdir(), "koi-provider-prog-"));
  });

  afterEach(async () => {
    await rm(userRoot, { recursive: true, force: true });
  });

  test("progressive: true attaches skills with empty content (no body loaded)", async () => {
    await writeSkill(userRoot, "my-skill");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    const provider = createSkillProvider(runtime, { progressive: true });

    const result = await provider.attach(STUB_AGENT);
    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;

    const token = skillToken("my-skill");
    const component = result.components.get(token) as
      | { name: string; description: string; content: string }
      | undefined;
    expect(component).toBeDefined();
    expect(component?.name).toBe("my-skill");
    expect(component?.description).toBe("Test my-skill.");
    expect(component?.content).toBe("");
  });

  test("progressive: true does not load bodies even for multiple skills", async () => {
    await writeSkill(userRoot, "skill-a", "Long body A.");
    await writeSkill(userRoot, "skill-b", "Long body B.");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    const provider = createSkillProvider(runtime, { progressive: true });

    const result = await provider.attach(STUB_AGENT);
    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;

    const a = result.components.get(skillToken("skill-a")) as { content: string } | undefined;
    const b = result.components.get(skillToken("skill-b")) as { content: string } | undefined;
    expect(a?.content).toBe("");
    expect(b?.content).toBe("");
  });

  test("progressive: true preserves description for XML rendering", async () => {
    await Bun.write(
      join(userRoot, "my-skill", "SKILL.md"),
      "---\nname: my-skill\ndescription: Does cool things.\n---\n\nBody.",
      { createPath: true },
    );
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    const provider = createSkillProvider(runtime, { progressive: true });

    const result = await provider.attach(STUB_AGENT);
    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;

    const component = result.components.get(skillToken("my-skill")) as
      | { description: string }
      | undefined;
    expect(component?.description).toBe("Does cool things.");
  });

  test("progressive: false (explicit) uses eager path — content is non-empty", async () => {
    await writeSkill(userRoot, "eager-skill", "Eager body.");
    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot });
    const provider = createSkillProvider(runtime, { progressive: false });

    const result = await provider.attach(STUB_AGENT);
    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;

    const component = result.components.get(skillToken("eager-skill")) as
      | { content: string }
      | undefined;
    expect(component?.content).toContain("Eager body.");
  });

  test("progressive attach calls loadAll() so blocked skills appear in skipped (startup cost parity)", async () => {
    // Both eager and progressive modes call loadAll() at startup — they have the same I/O
    // cost. Progressive mode's benefit is per-call token reduction (~100 tokens XML metadata
    // vs. full bodies injected at every model call). The bodies loaded by loadAll() remain
    // in the LRU cache for fast on-demand access when the Skill tool is invoked.
    await writeSkill(userRoot, "valid-skill", "Body.");
    // Write a skill with a HIGH-severity security finding to populate the skipped list.
    const blockedBody = '```typescript\neval("bad");\n```';
    await writeSkill(userRoot, "blocked-skill", blockedBody);

    const runtime = createSkillsRuntime({ bundledRoot: null, userRoot, blockOnSeverity: "HIGH" });
    const provider = createSkillProvider(runtime, { progressive: true });

    const result = await provider.attach(STUB_AGENT);
    expect(isAttachResult(result)).toBe(true);
    if (!isAttachResult(result)) return;

    // valid-skill: progressive component attached
    const component = result.components.get(skillToken("valid-skill")) as
      | { content: string; runtimeBacked: boolean }
      | undefined;
    expect(component?.content).toBe("");
    expect(component?.runtimeBacked).toBe(true);

    // blocked-skill: must appear in skipped — requires loadAll() path, not discover()-only
    const skippedNames = result.skipped.map((s) => s.name);
    expect(skippedNames).toContain("blocked-skill");
  });
});
