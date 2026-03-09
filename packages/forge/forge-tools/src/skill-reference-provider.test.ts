/**
 * Tests for the skill reference provider — progressive disclosure.
 *
 * Covers: Phase 3B (metadata → instructions → resources).
 */

import { describe, expect, test } from "bun:test";
import type { BrickId, SkillArtifact, ToolArtifact } from "@koi/core";
import { createInMemoryForgeStore } from "./memory-store.js";
import { createSkillReferenceProvider } from "./skill-reference-provider.js";

function makeSkillBrick(id: string, name: string, content: string): SkillArtifact {
  return {
    id: `sha256:${id}` as BrickId,
    kind: "skill",
    name,
    description: `Test skill: ${name}`,
    scope: "agent",
    origin: "forged",
    policy: { sandbox: true, capabilities: {} },
    lifecycle: "active",
    provenance: {
      source: { origin: "forged", forgedBy: "test", sessionId: "s1" },
      buildDefinition: { buildType: "test/v1", externalParameters: {} },
      builder: { id: "test/v1" },
      metadata: {
        invocationId: "inv-1",
        startedAt: 1000,
        finishedAt: 1000,
        sessionId: "s1",
        agentId: "test",
        depth: 0,
      },
      verification: { passed: true, sandbox: true, totalDurationMs: 0, stageResults: [] },
      classification: "public",
      contentMarkers: [],
      contentHash: `sha256:${id}` as BrickId,
    },
    version: "0.1.0",
    tags: ["test", "auto-forged"],
    usageCount: 0,
    content,
  };
}

function makeToolBrick(id: string, name: string): ToolArtifact {
  return {
    id: `sha256:${id}` as BrickId,
    kind: "tool",
    name,
    description: `Test tool: ${name}`,
    scope: "agent",
    origin: "forged",
    policy: { sandbox: true, capabilities: {} },
    lifecycle: "active",
    provenance: {
      source: { origin: "forged", forgedBy: "test", sessionId: "s1" },
      buildDefinition: { buildType: "test/v1", externalParameters: {} },
      builder: { id: "test/v1" },
      metadata: {
        invocationId: "inv-1",
        startedAt: 1000,
        finishedAt: 1000,
        sessionId: "s1",
        agentId: "test",
        depth: 0,
      },
      verification: { passed: true, sandbox: true, totalDurationMs: 0, stageResults: [] },
      classification: "public",
      contentMarkers: [],
      contentHash: `sha256:${id}` as BrickId,
    },
    version: "0.1.0",
    tags: ["test"],
    usageCount: 0,
    implementation: "// test",
    inputSchema: {},
  };
}

describe("createSkillReferenceProvider", () => {
  test("listSkills returns empty array when no skills exist", async () => {
    const store = createInMemoryForgeStore();
    const provider = createSkillReferenceProvider(store);
    const result = await provider.listSkills();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  test("listSkills returns metadata only (not full content)", async () => {
    const store = createInMemoryForgeStore();
    const skill = makeSkillBrick("abc", "deploy-workflow", "# Deploy\n\nStep 1...");
    await store.save(skill);

    const provider = createSkillReferenceProvider(store);
    const result = await provider.listSkills();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      const meta = result.value[0];
      expect(meta).toBeDefined();
      if (meta !== undefined) {
        expect(meta.name).toBe("deploy-workflow");
        expect(meta.description).toBe("Test skill: deploy-workflow");
        expect(meta.tags).toContain("test");
        // Should NOT have content field
        expect((meta as unknown as Record<string, unknown>).content).toBeUndefined();
      }
    }
  });

  test("listSkills filters out non-skill bricks", async () => {
    const store = createInMemoryForgeStore();
    await store.save(makeSkillBrick("s1", "skill-one", "content"));
    await store.save(makeToolBrick("t1", "tool-one"));
    await store.save(makeSkillBrick("s2", "skill-two", "content"));

    const provider = createSkillReferenceProvider(store);
    const result = await provider.listSkills();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(2);
      const names = result.value.map((m) => m.name);
      expect(names).toContain("skill-one");
      expect(names).toContain("skill-two");
    }
  });

  test("getInstructions returns full content for a skill", async () => {
    const store = createInMemoryForgeStore();
    const content = "# Deploy\n\n## Steps\n1. Build\n2. Test\n3. Deploy";
    await store.save(makeSkillBrick("abc", "deploy-workflow", content));

    const provider = createSkillReferenceProvider(store);
    const result = await provider.getInstructions("sha256:abc");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("deploy-workflow");
      expect(result.value.content).toBe(content);
    }
  });

  test("getInstructions returns NOT_FOUND for non-existent skill", async () => {
    const store = createInMemoryForgeStore();
    const provider = createSkillReferenceProvider(store);
    const result = await provider.getInstructions("sha256:missing");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("getInstructions returns error for non-skill brick", async () => {
    const store = createInMemoryForgeStore();
    await store.save(makeToolBrick("t1", "my-tool"));

    const provider = createSkillReferenceProvider(store);
    const result = await provider.getInstructions("sha256:t1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toContain("tool");
    }
  });
});
