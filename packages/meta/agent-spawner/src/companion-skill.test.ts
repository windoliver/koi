import { describe, expect, test } from "bun:test";
import { isAttachResult } from "@koi/core";
import { AGENT_SPAWNER_SKILL, createAgentSpawnerSkillProvider } from "./companion-skill.js";

describe("AGENT_SPAWNER_SKILL", () => {
  test("has required fields", () => {
    expect(AGENT_SPAWNER_SKILL.name).toBe("agent-spawner");
    expect(AGENT_SPAWNER_SKILL.description).toBeTruthy();
    expect(AGENT_SPAWNER_SKILL.content.length).toBeGreaterThan(0);
  });

  test("content mentions acp and stdio protocols", () => {
    expect(AGENT_SPAWNER_SKILL.content).toContain("acp");
    expect(AGENT_SPAWNER_SKILL.content).toContain("stdio");
  });
});

describe("createAgentSpawnerSkillProvider", () => {
  test("provider attaches under skill token", async () => {
    const provider = createAgentSpawnerSkillProvider();
    expect(provider.name).toBe("agent-spawner-skill");

    // Use a minimal Agent stub — attach doesn't use it
    const result = await provider.attach({} as never);

    if (isAttachResult(result)) {
      expect(result.components.size).toBe(1);
      expect(result.components.has("skill:agent-spawner")).toBe(true);
    } else {
      // Legacy map path
      expect(result.size).toBe(1);
    }
  });
});
