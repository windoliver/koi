import { describe, expect, test } from "bun:test";
import type { BrickId } from "@koi/core";
import { brickId } from "@koi/core";
import { computeBrickId, computeCompositeBrickId } from "@koi/hash";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import { loadAndVerify, verifyBrickIntegrity } from "./integrity.js";
import { createInMemoryForgeStore } from "./memory-store.js";
import type { AgentArtifact, CompositeArtifact, SkillArtifact, ToolArtifact } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers — create bricks with content-addressed ids (id IS the hash)
// ---------------------------------------------------------------------------

function createToolBrick(overrides?: Partial<ToolArtifact>): ToolArtifact {
  const implementation = overrides?.implementation ?? "return 1;";
  const files = overrides?.files;
  const id = overrides?.id ?? computeBrickId("tool", implementation, files);
  return {
    id,
    kind: "tool",
    name: "test-tool",
    description: "A test tool",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    implementation,
    inputSchema: { type: "object" },
    ...overrides,
    // Recompute id if overrides changed content but not id
    ...(overrides !== undefined && overrides.id === undefined
      ? {
          id: computeBrickId(
            "tool",
            overrides.implementation ?? implementation,
            overrides.files ?? files,
          ),
        }
      : {}),
  };
}

function createSkillBrick(overrides?: Partial<SkillArtifact>): SkillArtifact {
  const content = overrides?.content ?? "# Test Skill\nDo something useful.";
  const files = overrides?.files;
  const id = overrides?.id ?? computeBrickId("skill", content, files);
  return {
    id,
    kind: "skill",
    name: "test-skill",
    description: "A test skill",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    content,
    ...overrides,
    ...(overrides !== undefined && overrides.id === undefined
      ? { id: computeBrickId("skill", overrides.content ?? content, overrides.files ?? files) }
      : {}),
  };
}

function createAgentBrick(overrides?: Partial<AgentArtifact>): AgentArtifact {
  const manifestYaml = overrides?.manifestYaml ?? "name: test-agent\nmodel: gpt-4";
  const files = overrides?.files;
  const id = overrides?.id ?? computeBrickId("agent", manifestYaml, files);
  return {
    id,
    kind: "agent",
    name: "test-agent",
    description: "A test agent",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    manifestYaml,
    ...overrides,
    ...(overrides !== undefined && overrides.id === undefined
      ? {
          id: computeBrickId(
            "agent",
            overrides.manifestYaml ?? manifestYaml,
            overrides.files ?? files,
          ),
        }
      : {}),
  };
}

function createCompositeBrick(overrides?: Partial<CompositeArtifact>): CompositeArtifact {
  const brickIds: readonly BrickId[] = overrides?.brickIds ?? [
    brickId("brick_a"),
    brickId("brick_b"),
  ];
  const files = overrides?.files;
  const id = overrides?.id ?? computeCompositeBrickId(brickIds, files);
  return {
    id,
    kind: "composite",
    name: "test-composite",
    description: "A test composite",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    brickIds,
    ...overrides,
    ...(overrides !== undefined && overrides.id === undefined
      ? {
          id: computeCompositeBrickId(overrides.brickIds ?? brickIds, overrides.files ?? files),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// verifyBrickIntegrity
// ---------------------------------------------------------------------------

describe("verifyBrickIntegrity", () => {
  test("returns ok for tool with matching id", () => {
    const brick = createToolBrick();
    const result = verifyBrickIntegrity(brick);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.brickId).toBe(brick.id);
      expect(result.id).toBe(brick.id);
    }
  });

  test("returns ok for skill with matching id", () => {
    const brick = createSkillBrick();
    const result = verifyBrickIntegrity(brick);
    expect(result.ok).toBe(true);
  });

  test("returns ok for agent with matching id", () => {
    const brick = createAgentBrick();
    const result = verifyBrickIntegrity(brick);
    expect(result.ok).toBe(true);
  });

  test("returns ok for composite with matching id", () => {
    const brick = createCompositeBrick();
    const result = verifyBrickIntegrity(brick);
    expect(result.ok).toBe(true);
  });

  test("detects tampered tool implementation", () => {
    const brick = createToolBrick();
    // Tamper: modify implementation without updating id
    const tampered: ToolArtifact = { ...brick, implementation: "return 'HACKED';" };
    const result = verifyBrickIntegrity(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.expectedId).toBe(brick.id);
      expect(result.actualId).not.toBe(brick.id);
    }
  });

  test("detects tampered skill content", () => {
    const brick = createSkillBrick();
    const tampered: SkillArtifact = { ...brick, content: "# Malicious content" };
    const result = verifyBrickIntegrity(tampered);
    expect(result.ok).toBe(false);
  });

  test("detects tampered agent manifestYaml", () => {
    const brick = createAgentBrick();
    const tampered: AgentArtifact = { ...brick, manifestYaml: "name: evil-agent" };
    const result = verifyBrickIntegrity(tampered);
    expect(result.ok).toBe(false);
  });

  test("detects tampered composite brickIds", () => {
    const brick = createCompositeBrick();
    const tampered: CompositeArtifact = { ...brick, brickIds: [brickId("brick_evil")] };
    const result = verifyBrickIntegrity(tampered);
    expect(result.ok).toBe(false);
  });

  test("detects tampered files", () => {
    const brick = createToolBrick({ files: { "helper.ts": "export const x = 1;" } });
    const tampered: ToolArtifact = {
      ...brick,
      files: { "helper.ts": "export const x = 'EVIL';" },
    };
    const result = verifyBrickIntegrity(tampered);
    expect(result.ok).toBe(false);
  });

  test("handles brick with no files", () => {
    const brick = createToolBrick();
    expect(brick.files).toBeUndefined();
    const result = verifyBrickIntegrity(brick);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadAndVerify
// ---------------------------------------------------------------------------

describe("loadAndVerify", () => {
  test("returns brick + passing integrity for valid brick", async () => {
    const store = createInMemoryForgeStore();
    const brick = createToolBrick();
    await store.save(brick);

    const result = await loadAndVerify(store, brick.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.brick.id).toBe(brick.id);
      expect(result.value.integrity.ok).toBe(true);
    }
  });

  test("returns brick + failing integrity for tampered brick", async () => {
    const store = createInMemoryForgeStore();
    const brick = createToolBrick();
    await store.save(brick);

    // Tamper the brick in the store directly (keeping same id, changing content)
    const tampered: ToolArtifact = { ...brick, implementation: "return 'HACKED';" };
    await store.save(tampered);

    const result = await loadAndVerify(store, brick.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.brick.id).toBe(brick.id);
      expect(result.value.integrity.ok).toBe(false);
    }
  });

  test("returns ForgeError when brick not found", async () => {
    const store = createInMemoryForgeStore();

    const result = await loadAndVerify(store, brickId("nonexistent"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("store");
      expect(result.error.code).toBe("LOAD_FAILED");
    }
  });
});
