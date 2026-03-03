import { describe, expect, test } from "bun:test";
import type { AttachResult, SkillComponent } from "@koi/core";
import { isAttachResult, skillToken } from "@koi/core";
import { createMockAgent } from "@koi/test-utils";
import { createOrchestratorProvider } from "../provider.js";

function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

describe("SkillComponent attachment", () => {
  test("attach() includes SkillComponent with correct name and non-empty content", async () => {
    const provider = createOrchestratorProvider({
      spawn: async () => ({ ok: true, output: "done" }),
    });
    const result = extractMap(await provider.attach(createMockAgent()));

    const skill = result.get(skillToken("orchestrator") as string);
    expect(skill).toBeDefined();
    expect((skill as SkillComponent).name).toBe("orchestrator");
    expect((skill as SkillComponent).content.length).toBeGreaterThan(200);
    expect((skill as SkillComponent).content).toContain("## ");
  });
});
