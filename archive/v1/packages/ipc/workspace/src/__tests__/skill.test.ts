/**
 * Unit tests — skill component attachment via workspace provider.
 *
 * Validates that createWorkspaceProvider attaches a SkillComponent
 * alongside the WORKSPACE component during attach().
 */

import { describe, expect, test } from "bun:test";
import type {
  AttachResult,
  ResolvedWorkspaceConfig,
  SkillComponent,
  WorkspaceBackend,
  WorkspaceId,
} from "@koi/core";
import { agentId, isAttachResult, skillToken } from "@koi/core";
import { createMockAgent } from "@koi/test-utils";
import { createWorkspaceProvider } from "../provider.js";
import { WORKSPACE_SKILL_NAME } from "../skill.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal in-memory backend that always succeeds. */
function createStubBackend(): WorkspaceBackend {
  return {
    name: "stub",
    isSandboxed: false,
    create: async (_agentId, _config: ResolvedWorkspaceConfig) => ({
      ok: true as const,
      value: {
        id: "ws-stub-1" as WorkspaceId,
        path: "/tmp/ws-stub-1",
        createdAt: Date.now(),
        metadata: {},
      },
    }),
    dispose: async (_workspaceId) => ({ ok: true as const, value: undefined }),
    isHealthy: () => true,
  };
}

function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SkillComponent attachment", () => {
  test("attach() includes SkillComponent with correct name and non-empty content", async () => {
    const result = createWorkspaceProvider({
      backend: createStubBackend(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const provider = result.value;
    const agent = createMockAgent({
      pid: { id: agentId("skill-test-agent") },
      state: "running",
    });

    const rawComponents = await provider.attach(agent);
    const components = extractMap(rawComponents);

    const skillKey = skillToken(WORKSPACE_SKILL_NAME) as string;
    const skill = components.get(skillKey);

    expect(skill).toBeDefined();
    expect((skill as SkillComponent).name).toBe("workspace");
    expect((skill as SkillComponent).content.length).toBeGreaterThan(200);
    expect((skill as SkillComponent).content).toContain("## ");
  });

  test("SkillComponent has expected tags", async () => {
    const result = createWorkspaceProvider({
      backend: createStubBackend(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const provider = result.value;
    const agent = createMockAgent({
      pid: { id: agentId("tags-test-agent") },
      state: "running",
    });

    const rawComponents = await provider.attach(agent);
    const components = extractMap(rawComponents);

    const skillKey = skillToken(WORKSPACE_SKILL_NAME) as string;
    const skill = components.get(skillKey) as SkillComponent;

    expect(skill.tags).toEqual(["workspace", "isolation", "lifecycle"]);
  });

  test("SkillComponent description is non-empty", async () => {
    const result = createWorkspaceProvider({
      backend: createStubBackend(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const provider = result.value;
    const agent = createMockAgent({
      pid: { id: agentId("desc-test-agent") },
      state: "running",
    });

    const rawComponents = await provider.attach(agent);
    const components = extractMap(rawComponents);

    const skillKey = skillToken(WORKSPACE_SKILL_NAME) as string;
    const skill = components.get(skillKey) as SkillComponent;

    expect(skill.description.length).toBeGreaterThan(10);
  });
});
