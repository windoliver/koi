/**
 * Tests for SkillComponent attachment via createCodeModeProvider.
 */

import { describe, expect, test } from "bun:test";
import type { AttachResult, SkillComponent } from "@koi/core";
import { isAttachResult, skillToken } from "@koi/core";
import { createCodeModeProvider } from "../component-provider.js";
import { createMockAgent, createMockBackend } from "../test-helpers.js";

/** Extract ReadonlyMap from attach() result (handles both AttachResult and bare Map). */
function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

describe("SkillComponent attachment", () => {
  test("attach() includes SkillComponent with correct name and non-empty content", async () => {
    const provider = createCodeModeProvider();
    // code-mode provider needs a FILESYSTEM component on the agent
    const backend = createMockBackend();
    const agent = createMockAgent(backend);
    const map = extractMap(await provider.attach(agent));

    const skill = map.get(skillToken("code-mode") as string);
    expect(skill).toBeDefined();
    expect((skill as SkillComponent).name).toBe("code-mode");
    expect((skill as SkillComponent).content.length).toBeGreaterThan(200);
    expect((skill as SkillComponent).content).toContain("## ");
  });

  test("attach() does NOT include SkillComponent when FILESYSTEM is missing", async () => {
    const provider = createCodeModeProvider();
    // Agent without FILESYSTEM component
    const agent = createMockAgent();
    const map = extractMap(await provider.attach(agent));

    // Should return empty map — no tools and no skill
    expect(map.size).toBe(0);
    expect(map.get(skillToken("code-mode") as string)).toBeUndefined();
  });

  test("SkillComponent has expected tags", async () => {
    const provider = createCodeModeProvider();
    const backend = createMockBackend();
    const agent = createMockAgent(backend);
    const map = extractMap(await provider.attach(agent));

    const skill = map.get(skillToken("code-mode") as string) as SkillComponent;
    expect(skill.tags).toEqual(["code-generation", "planning", "filesystem"]);
  });

  test("SkillComponent content covers all three tools", async () => {
    const provider = createCodeModeProvider();
    const backend = createMockBackend();
    const agent = createMockAgent(backend);
    const map = extractMap(await provider.attach(agent));

    const skill = map.get(skillToken("code-mode") as string) as SkillComponent;
    expect(skill.content).toContain("code_plan_create");
    expect(skill.content).toContain("code_plan_apply");
    expect(skill.content).toContain("code_plan_status");
  });
});
