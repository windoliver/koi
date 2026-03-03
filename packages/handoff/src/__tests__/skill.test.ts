/**
 * Tests for SkillComponent attachment via createHandoffProvider.
 */

import { describe, expect, test } from "bun:test";
import type { AttachResult, SkillComponent } from "@koi/core";
import { agentId, isAttachResult, skillToken } from "@koi/core";
import { createMockAgent } from "@koi/test-utils";
import { createHandoffProvider } from "../provider.js";
import { createInMemoryHandoffStore } from "../store.js";

function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

describe("SkillComponent attachment", () => {
  test("attach() includes SkillComponent with correct name and non-empty content", async () => {
    const provider = createHandoffProvider({
      store: createInMemoryHandoffStore(),
      agentId: agentId("test-agent"),
    });
    const result = extractMap(await provider.attach(createMockAgent()));

    const skill = result.get(skillToken("handoff") as string);
    expect(skill).toBeDefined();
    expect((skill as SkillComponent).name).toBe("handoff");
    expect((skill as SkillComponent).content.length).toBeGreaterThan(200);
    expect((skill as SkillComponent).content).toContain("## ");
  });

  test("SkillComponent has expected tags", async () => {
    const provider = createHandoffProvider({
      store: createInMemoryHandoffStore(),
      agentId: agentId("test-agent"),
    });
    const result = extractMap(await provider.attach(createMockAgent()));

    const skill = result.get(skillToken("handoff") as string) as SkillComponent;
    expect(skill.tags).toEqual(["handoff", "pipeline", "context-transfer"]);
  });

  test("SkillComponent content covers both tools", async () => {
    const provider = createHandoffProvider({
      store: createInMemoryHandoffStore(),
      agentId: agentId("test-agent"),
    });
    const result = extractMap(await provider.attach(createMockAgent()));

    const skill = result.get(skillToken("handoff") as string) as SkillComponent;
    expect(skill.content).toContain("prepare_handoff");
    expect(skill.content).toContain("accept_handoff");
  });

  test("attach() returns tools alongside skill", async () => {
    const provider = createHandoffProvider({
      store: createInMemoryHandoffStore(),
      agentId: agentId("test-agent"),
    });
    const result = extractMap(await provider.attach(createMockAgent()));

    expect(result.has("tool:prepare_handoff")).toBe(true);
    expect(result.has("tool:accept_handoff")).toBe(true);
    expect(result.has(skillToken("handoff") as string)).toBe(true);
    expect(result.size).toBe(3);
  });
});
