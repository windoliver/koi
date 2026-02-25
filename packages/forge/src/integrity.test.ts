import { describe, expect, test } from "bun:test";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import { loadAndVerify, verifyBrickIntegrity } from "./integrity.js";
import { createInMemoryForgeStore } from "./memory-store.js";
import { computeContentHash } from "./tools/shared.js";
import type { AgentArtifact, CompositeArtifact, SkillArtifact, ToolArtifact } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers — create bricks with correct content hashes
// ---------------------------------------------------------------------------

function createToolBrick(overrides?: Partial<ToolArtifact>): ToolArtifact {
  const implementation = overrides?.implementation ?? "return 1;";
  const files = overrides?.files;
  return {
    id: "brick_tool",
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
    contentHash: computeContentHash(implementation, files),
    implementation,
    inputSchema: { type: "object" },
    ...overrides,
    // Recompute hash if overrides changed content but not contentHash
    ...(overrides !== undefined && overrides.contentHash === undefined
      ? {
          contentHash: computeContentHash(
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
  return {
    id: "brick_skill",
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
    contentHash: computeContentHash(content, files),
    content,
    ...overrides,
    ...(overrides !== undefined && overrides.contentHash === undefined
      ? { contentHash: computeContentHash(overrides.content ?? content, overrides.files ?? files) }
      : {}),
  };
}

function createAgentBrick(overrides?: Partial<AgentArtifact>): AgentArtifact {
  const manifestYaml = overrides?.manifestYaml ?? "name: test-agent\nmodel: gpt-4";
  const files = overrides?.files;
  return {
    id: "brick_agent",
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
    contentHash: computeContentHash(manifestYaml, files),
    manifestYaml,
    ...overrides,
    ...(overrides !== undefined && overrides.contentHash === undefined
      ? {
          contentHash: computeContentHash(
            overrides.manifestYaml ?? manifestYaml,
            overrides.files ?? files,
          ),
        }
      : {}),
  };
}

function createCompositeBrick(overrides?: Partial<CompositeArtifact>): CompositeArtifact {
  const brickIds = overrides?.brickIds ?? ["brick_a", "brick_b"];
  const files = overrides?.files;
  return {
    id: "brick_composite",
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
    contentHash: computeContentHash(brickIds.join(","), files),
    brickIds,
    ...overrides,
    ...(overrides !== undefined && overrides.contentHash === undefined
      ? {
          contentHash: computeContentHash(
            (overrides.brickIds ?? brickIds).join(","),
            overrides.files ?? files,
          ),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// verifyBrickIntegrity
// ---------------------------------------------------------------------------

describe("verifyBrickIntegrity", () => {
  test("returns ok for tool with matching hash", async () => {
    const brick = createToolBrick();
    const result = await verifyBrickIntegrity(brick);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.brickId).toBe(brick.id);
      expect(result.hash).toBe(brick.contentHash);
    }
  });

  test("returns ok for skill with matching hash", async () => {
    const brick = createSkillBrick();
    const result = await verifyBrickIntegrity(brick);
    expect(result.ok).toBe(true);
  });

  test("returns ok for agent with matching hash", async () => {
    const brick = createAgentBrick();
    const result = await verifyBrickIntegrity(brick);
    expect(result.ok).toBe(true);
  });

  test("returns ok for composite with matching hash", async () => {
    const brick = createCompositeBrick();
    const result = await verifyBrickIntegrity(brick);
    expect(result.ok).toBe(true);
  });

  test("detects tampered tool implementation", async () => {
    const brick = createToolBrick();
    // Tamper: modify implementation without updating contentHash
    const tampered: ToolArtifact = { ...brick, implementation: "return 'HACKED';" };
    const result = await verifyBrickIntegrity(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.expectedHash).toBe(brick.contentHash);
      expect(result.actualHash).not.toBe(brick.contentHash);
    }
  });

  test("detects tampered skill content", async () => {
    const brick = createSkillBrick();
    const tampered: SkillArtifact = { ...brick, content: "# Malicious content" };
    const result = await verifyBrickIntegrity(tampered);
    expect(result.ok).toBe(false);
  });

  test("detects tampered agent manifestYaml", async () => {
    const brick = createAgentBrick();
    const tampered: AgentArtifact = { ...brick, manifestYaml: "name: evil-agent" };
    const result = await verifyBrickIntegrity(tampered);
    expect(result.ok).toBe(false);
  });

  test("detects tampered composite brickIds", async () => {
    const brick = createCompositeBrick();
    const tampered: CompositeArtifact = { ...brick, brickIds: ["brick_evil"] };
    const result = await verifyBrickIntegrity(tampered);
    expect(result.ok).toBe(false);
  });

  test("detects tampered files", async () => {
    const brick = createToolBrick({ files: { "helper.ts": "export const x = 1;" } });
    const tampered: ToolArtifact = {
      ...brick,
      files: { "helper.ts": "export const x = 'EVIL';" },
    };
    const result = await verifyBrickIntegrity(tampered);
    expect(result.ok).toBe(false);
  });

  test("handles brick with no files", async () => {
    const brick = createToolBrick();
    expect(brick.files).toBeUndefined();
    const result = await verifyBrickIntegrity(brick);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadAndVerify
// ---------------------------------------------------------------------------

describe("loadAndVerify", () => {
  test("returns brick + passing integrity for valid brick", async () => {
    const store = createInMemoryForgeStore();
    const brick = createToolBrick({ id: "brick_1" });
    await store.save(brick);

    const result = await loadAndVerify(store, "brick_1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.brick.id).toBe("brick_1");
      expect(result.value.integrity.ok).toBe(true);
    }
  });

  test("returns brick + failing integrity for tampered brick", async () => {
    const store = createInMemoryForgeStore();
    const brick = createToolBrick({ id: "brick_1" });
    await store.save(brick);

    // Tamper the brick in the store directly
    const tampered: ToolArtifact = { ...brick, implementation: "return 'HACKED';" };
    await store.save(tampered);

    const result = await loadAndVerify(store, "brick_1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.brick.id).toBe("brick_1");
      expect(result.value.integrity.ok).toBe(false);
    }
  });

  test("returns ForgeError when brick not found", async () => {
    const store = createInMemoryForgeStore();

    const result = await loadAndVerify(store, "nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("store");
      expect(result.error.code).toBe("LOAD_FAILED");
    }
  });
});
