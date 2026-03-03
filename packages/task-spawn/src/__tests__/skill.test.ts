import { describe, expect, test } from "bun:test";
import type { AttachResult, SkillComponent } from "@koi/core";
import { isAttachResult, skillToken } from "@koi/core";
import { createMockAgent } from "@koi/test-utils";
import { createTaskSpawnProvider } from "../provider.js";

function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

describe("SkillComponent attachment", () => {
  test("attach() includes SkillComponent with correct name and non-empty content", async () => {
    const provider = createTaskSpawnProvider({
      agents: new Map([
        [
          "test",
          {
            name: "test-agent",
            description: "A test agent",
            manifest: { name: "test-agent", version: "0.0.1", model: { name: "test-model" } },
          },
        ],
      ]),
      spawn: async () => ({ ok: true, output: "done" }),
    });
    const result = extractMap(await provider.attach(createMockAgent()));

    const skill = result.get(skillToken("task-spawn") as string);
    expect(skill).toBeDefined();
    expect((skill as SkillComponent).name).toBe("task-spawn");
    expect((skill as SkillComponent).content.length).toBeGreaterThan(200);
    expect((skill as SkillComponent).content).toContain("## ");
  });
});
