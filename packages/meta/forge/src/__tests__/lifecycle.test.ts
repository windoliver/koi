/**
 * End-to-end lifecycle test — exercises the full forge workflow
 * through the public primordial tool API against a shared store.
 *
 * Flow: forge_tool → search_forge → forge_skill → search by kind
 *     → search by tags → hit governance rate limit
 */

import { describe, expect, test } from "bun:test";
import type { SandboxExecutor } from "@koi/core";
import { createDefaultForgeConfig } from "../config.js";
import { createInMemoryForgeStore } from "../memory-store.js";
import { createForgeSkillTool } from "../tools/forge-skill.js";
import { createForgeToolTool } from "../tools/forge-tool.js";
import { createSearchForgeTool } from "../tools/search-forge.js";
import type { ForgeDeps } from "../tools/shared.js";
import type { BrickArtifact, ForgeContext, ForgeResult } from "../types.js";

function mockExecutor(): SandboxExecutor {
  return {
    execute: async (_code, input, _timeout) => ({
      ok: true,
      value: { output: input, durationMs: 1 },
    }),
  };
}

describe("Forge lifecycle — end-to-end", () => {
  test("forge tool → discover → forge skill → search → governance limit", async () => {
    const store = createInMemoryForgeStore();
    const config = createDefaultForgeConfig({ maxForgesPerSession: 3 });
    const context: ForgeContext = {
      agentId: "agent-lifecycle",
      depth: 0,
      sessionId: "session-e2e",
      forgesThisSession: 0,
    };

    const deps: ForgeDeps = {
      store,
      executor: mockExecutor(),
      verifiers: [],
      config,
      context,
    };

    const forgeTool = createForgeToolTool(deps);
    const forgeSkill = createForgeSkillTool(deps);
    const searchForge = createSearchForgeTool(deps);

    // --- Step 1: Forge a tool ---
    const toolResult = (await forgeTool.execute({
      name: "adder",
      description: "Adds two numbers",
      inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
      implementation: "return input.a + input.b;",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(toolResult.ok).toBe(true);
    expect(toolResult.value.kind).toBe("tool");
    expect(toolResult.value.name).toBe("adder");
    expect(toolResult.value.trustTier).toBe("sandbox");
    expect(toolResult.value.lifecycle).toBe("active");
    expect(toolResult.value.verificationReport.passed).toBe(true);
    expect(toolResult.value.verificationReport.stages).toHaveLength(6);
    expect(toolResult.value.metadata.forgedBy).toBe("agent-lifecycle");
    expect(toolResult.value.metadata.sessionId).toBe("session-e2e");
    expect(toolResult.value.forgesConsumed).toBe(1);

    const toolId = toolResult.value.id;
    expect(toolId).toMatch(/^sha256:[0-9a-f]{64}$/);

    // --- Step 2: Search — find the forged tool ---
    const searchAll = (await searchForge.execute({})) as {
      readonly ok: true;
      readonly value: readonly BrickArtifact[];
    };

    expect(searchAll.ok).toBe(true);
    expect(searchAll.value.length).toBe(1);
    const firstBrick = searchAll.value[0];
    expect(firstBrick?.id).toBe(toolId);
    expect(firstBrick?.kind).toBe("tool");

    // --- Step 3: Forge a skill with tags ---
    const skillResult = (await forgeSkill.execute({
      name: "mathHelper",
      description: "Tips for math operations",
      body: "# Math Helper\n\nUse the adder tool for addition.",
      tags: ["math", "helper"],
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(skillResult.ok).toBe(true);
    expect(skillResult.value.kind).toBe("skill");
    expect(skillResult.value.name).toBe("mathHelper");
    expect(skillResult.value.lifecycle).toBe("active");

    const skillId = skillResult.value.id;

    // --- Step 4: Search by kind — tools only ---
    const toolsOnly = (await searchForge.execute({ kind: "tool" })) as {
      readonly ok: true;
      readonly value: readonly BrickArtifact[];
    };

    expect(toolsOnly.ok).toBe(true);
    expect(toolsOnly.value.length).toBe(1);
    expect(toolsOnly.value[0]?.id).toBe(toolId);

    // --- Step 5: Search by kind — skills only ---
    const skillsOnly = (await searchForge.execute({ kind: "skill" })) as {
      readonly ok: true;
      readonly value: readonly BrickArtifact[];
    };

    expect(skillsOnly.ok).toBe(true);
    expect(skillsOnly.value.length).toBe(1);
    expect(skillsOnly.value[0]?.id).toBe(skillId);

    // --- Step 6: Search all — both bricks present ---
    const allBricks = (await searchForge.execute({})) as {
      readonly ok: true;
      readonly value: readonly BrickArtifact[];
    };

    expect(allBricks.ok).toBe(true);
    expect(allBricks.value.length).toBe(2);

    // --- Step 7: Search by tags ---
    const byTag = (await searchForge.execute({ tags: ["math"] })) as {
      readonly ok: true;
      readonly value: readonly BrickArtifact[];
    };

    expect(byTag.ok).toBe(true);
    expect(byTag.value.length).toBe(1);
    expect(byTag.value[0]?.name).toBe("mathHelper");

    // --- Step 8: Forge a third tool (still within limit of 3) ---
    // Note: forgesThisSession is a snapshot — governance checks against it.
    // The context was created with forgesThisSession: 0 and limit: 3,
    // so the 3rd forge should still pass.
    const tool2Result = (await forgeTool.execute({
      name: "multiplier",
      description: "Multiplies two numbers",
      inputSchema: { type: "object" },
      implementation: "return input.a * input.b;",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(tool2Result.ok).toBe(true);
    expect(tool2Result.value.name).toBe("multiplier");

    // --- Step 9: Hit governance limit ---
    // Create new deps with forgesThisSession at the limit
    const limitedDeps: ForgeDeps = {
      ...deps,
      context: { ...context, forgesThisSession: 3 },
    };
    const limitedForgeTool = createForgeToolTool(limitedDeps);

    const blocked = (await limitedForgeTool.execute({
      name: "divider",
      description: "Divides two numbers",
      inputSchema: { type: "object" },
      implementation: "return input.a / input.b;",
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string };
    };

    expect(blocked.ok).toBe(false);
    expect(blocked.error.stage).toBe("governance");
    expect(blocked.error.code).toBe("MAX_SESSION_FORGES");

    // --- Step 10: Verify store still has exactly 3 bricks ---
    const finalSearch = (await searchForge.execute({})) as {
      readonly ok: true;
      readonly value: readonly BrickArtifact[];
    };

    expect(finalSearch.ok).toBe(true);
    expect(finalSearch.value.length).toBe(3);

    // Verify all 3 are active with correct kinds
    const kinds = finalSearch.value.map((b) => b.kind).sort();
    expect(kinds).toEqual(["skill", "tool", "tool"]);
  });

  test("forge at depth > max is rejected", async () => {
    const store = createInMemoryForgeStore();
    const config = createDefaultForgeConfig({ maxForgeDepth: 1 });
    const context: ForgeContext = {
      agentId: "deep-agent",
      depth: 2,
      sessionId: "session-deep",
      forgesThisSession: 0,
    };

    const deps: ForgeDeps = {
      store,
      executor: mockExecutor(),
      verifiers: [],
      config,
      context,
    };

    const forgeTool = createForgeToolTool(deps);

    const result = (await forgeTool.execute({
      name: "deepTool",
      description: "Should be rejected",
      inputSchema: { type: "object" },
      implementation: "return 1;",
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("governance");
    expect(result.error.code).toBe("MAX_DEPTH");

    // Store should be empty — nothing saved
    const search = (await store.search({})) as {
      readonly ok: true;
      readonly value: readonly BrickArtifact[];
    };
    expect(search.ok).toBe(true);
    expect(search.value.length).toBe(0);
  });

  test("forge disabled rejects all operations", async () => {
    const store = createInMemoryForgeStore();
    const config = createDefaultForgeConfig({ enabled: false });
    const context: ForgeContext = {
      agentId: "agent-1",
      depth: 0,
      sessionId: "session-1",
      forgesThisSession: 0,
    };

    const deps: ForgeDeps = {
      store,
      executor: mockExecutor(),
      verifiers: [],
      config,
      context,
    };

    const forgeTool = createForgeToolTool(deps);
    const forgeSkill = createForgeSkillTool(deps);
    const searchForge = createSearchForgeTool(deps);

    // All three tools should reject
    const toolResult = (await forgeTool.execute({
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return 1;",
    })) as { readonly ok: false; readonly error: { readonly stage: string } };

    const skillResult = (await forgeSkill.execute({
      name: "mySkill",
      description: "A skill",
      body: "# Skill content",
    })) as { readonly ok: false; readonly error: { readonly stage: string } };

    const searchResult = (await searchForge.execute({})) as {
      readonly ok: false;
      readonly error: { readonly stage: string };
    };

    expect(toolResult.ok).toBe(false);
    expect(toolResult.error.stage).toBe("governance");

    expect(skillResult.ok).toBe(false);
    expect(skillResult.error.stage).toBe("governance");

    expect(searchResult.ok).toBe(false);
    expect(searchResult.error.stage).toBe("governance");
  });
});
