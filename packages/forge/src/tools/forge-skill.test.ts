import { describe, expect, test } from "bun:test";
import { createDefaultForgeConfig } from "../config.js";
import { createInMemoryForgeStore } from "../memory-store.js";
import type { ForgeResult } from "../types.js";
import { createForgeSkillTool } from "./forge-skill.js";
import type { ForgeDeps } from "./shared.js";

function createDeps(overrides?: Partial<ForgeDeps>): ForgeDeps {
  return {
    store: createInMemoryForgeStore(),
    executor: { execute: async () => ({ ok: true, value: { output: "ok", durationMs: 1 } }) },
    verifiers: [],
    config: createDefaultForgeConfig(),
    context: { agentId: "agent-1", depth: 0, sessionId: "session-1", forgesThisSession: 0 },
    ...overrides,
  };
}

describe("createForgeSkillTool", () => {
  test("has correct descriptor", () => {
    const tool = createForgeSkillTool(createDeps());
    expect(tool.descriptor.name).toBe("forge_skill");
  });

  test("forges a skill and saves to store", async () => {
    const store = createInMemoryForgeStore();
    const tool = createForgeSkillTool(createDeps({ store }));

    const result = (await tool.execute({
      name: "mySkill",
      description: "A skill",
      content: "# My Skill\nContent here.",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe("skill");
    expect(result.value.name).toBe("mySkill");
    expect(result.value.lifecycle).toBe("active");

    // Verify saved in store
    const loadResult = await store.load(result.value.id);
    expect(loadResult.ok).toBe(true);
  });

  test("does not run sandbox for skills", async () => {
    const tool = createForgeSkillTool(createDeps());
    const result = (await tool.execute({
      name: "mySkill",
      description: "A skill",
      content: "Some content here.",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    // Sandbox stage should show as skipped
    const sandboxStage = result.value.verificationReport.stages.find((s) => s.stage === "sandbox");
    expect(sandboxStage?.message).toContain("Skipped");
  });

  test("propagates tags", async () => {
    const store = createInMemoryForgeStore();
    const tool = createForgeSkillTool(createDeps({ store }));

    const result = (await tool.execute({
      name: "taggedSkill",
      description: "A tagged skill",
      content: "Content",
      tags: ["math", "calc"],
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    const loadResult = await store.load(result.value.id);
    if (loadResult.ok) {
      expect(loadResult.value.tags).toEqual(["math", "calc"]);
    }
  });

  test("returns error for invalid name", async () => {
    const tool = createForgeSkillTool(createDeps());
    const result = (await tool.execute({
      name: "x",
      description: "A skill",
      content: "Content",
    })) as { readonly ok: false; readonly error: { readonly stage: string } };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
  });

  test("propagates files to artifact", async () => {
    const store = createInMemoryForgeStore();
    const tool = createForgeSkillTool(createDeps({ store }));

    const result = (await tool.execute({
      name: "filesSkill",
      description: "A skill with files",
      content: "# Skill",
      files: { "lib/helper.ts": "export const x = 1;" },
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    const loadResult = await store.load(result.value.id);
    if (loadResult.ok) {
      expect(loadResult.value.files).toEqual({ "lib/helper.ts": "export const x = 1;" });
    }
  });

  test("propagates requires to artifact", async () => {
    const store = createInMemoryForgeStore();
    const tool = createForgeSkillTool(createDeps({ store }));

    const result = (await tool.execute({
      name: "reqSkill",
      description: "A skill with requires",
      content: "# Skill",
      requires: { bins: ["node"], env: ["API_KEY"] },
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    const loadResult = await store.load(result.value.id);
    if (loadResult.ok) {
      expect(loadResult.value.requires).toEqual({ bins: ["node"], env: ["API_KEY"] });
    }
  });
});
