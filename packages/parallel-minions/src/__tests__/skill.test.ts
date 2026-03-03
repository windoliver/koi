/**
 * Unit test for the parallel-minions SkillComponent attachment.
 *
 * Verifies that createParallelMinionsProvider attaches a SkillComponent
 * alongside the parallel_task tool.
 */

import { describe, expect, test } from "bun:test";
import type { SkillComponent } from "@koi/core";
import { skillToken } from "@koi/core";
import { createMockAgent } from "@koi/test-utils";
import { createParallelMinionsProvider } from "../provider.js";
import { PARALLEL_MINIONS_SKILL_NAME } from "../skill.js";
import type { ParallelMinionsConfig } from "../types.js";

const WORKER_MANIFEST = {
  name: "test-worker",
  version: "0.0.1" as const,
  description: "A test worker",
  model: { name: "test-model" },
} as const;

const MINIMAL_CONFIG: ParallelMinionsConfig = {
  agents: new Map([
    [
      "worker",
      {
        name: "test-worker",
        description: "A test worker",
        manifest: WORKER_MANIFEST,
      },
    ],
  ]),
  spawn: async () => ({ ok: true, output: "done" }),
  defaultAgent: "worker",
};

describe("SkillComponent attachment", () => {
  test("attach() includes SkillComponent with correct name and non-empty content", async () => {
    const provider = createParallelMinionsProvider(MINIMAL_CONFIG);
    const result = await provider.attach(createMockAgent());

    const skillKey = skillToken(PARALLEL_MINIONS_SKILL_NAME) as string;
    const skill = (result as ReadonlyMap<string, unknown>).get(skillKey) as
      | SkillComponent
      | undefined;

    expect(skill).toBeDefined();
    expect(skill?.name).toBe("parallel-minions");
    expect(skill?.content.length).toBeGreaterThan(200);
    expect(skill?.content).toContain("## ");
  });

  test("SkillComponent includes delegation and strategy guidance", async () => {
    const provider = createParallelMinionsProvider(MINIMAL_CONFIG);
    const result = await provider.attach(createMockAgent());

    const skillKey = skillToken(PARALLEL_MINIONS_SKILL_NAME) as string;
    const skill = (result as ReadonlyMap<string, unknown>).get(skillKey) as SkillComponent;

    expect(skill.content).toContain("parallel_task");
    expect(skill.content).toContain("best-effort");
    expect(skill.content).toContain("fail-fast");
    expect(skill.content).toContain("quorum");
  });

  test("SkillComponent has expected tags", async () => {
    const provider = createParallelMinionsProvider(MINIMAL_CONFIG);
    const result = await provider.attach(createMockAgent());

    const skillKey = skillToken(PARALLEL_MINIONS_SKILL_NAME) as string;
    const skill = (result as ReadonlyMap<string, unknown>).get(skillKey) as SkillComponent;

    expect(skill.tags).toContain("delegation");
    expect(skill.tags).toContain("parallel");
    expect(skill.tags).toContain("fan-out");
  });

  test("tool:parallel_task is still attached alongside skill", async () => {
    const provider = createParallelMinionsProvider(MINIMAL_CONFIG);
    const result = await provider.attach(createMockAgent());
    const components = result as ReadonlyMap<string, unknown>;

    expect(components.has("tool:parallel_task")).toBe(true);
    expect(components.has(skillToken(PARALLEL_MINIONS_SKILL_NAME) as string)).toBe(true);
  });
});
