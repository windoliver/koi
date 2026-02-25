import { describe, expect, test } from "bun:test";
import type { CompositeArtifact, SkillArtifact, ToolArtifact } from "@koi/core";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import type { AssembleManifestOptions } from "./assemble-manifest.js";
import { assembleManifest } from "./assemble-manifest.js";
import { createInMemoryForgeStore } from "./memory-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_FIELDS = {
  scope: "agent" as const,
  trustTier: "sandbox" as const,
  lifecycle: "active" as const,
  provenance: DEFAULT_PROVENANCE,
  version: "0.0.1",
  tags: [],
  usageCount: 0,
  contentHash: "abc123",
} as const;

function toolBrick(id: string, name: string): ToolArtifact {
  return {
    ...BASE_FIELDS,
    id,
    kind: "tool",
    name,
    description: `Tool: ${name}`,
    implementation: "return 1;",
    inputSchema: { type: "object" },
  };
}

function skillBrick(id: string, name: string): SkillArtifact {
  return {
    ...BASE_FIELDS,
    id,
    kind: "skill",
    name,
    description: `Skill: ${name}`,
    content: "# Skill body",
  };
}

function compositeBrick(id: string, name: string, brickIds: readonly string[]): CompositeArtifact {
  return {
    ...BASE_FIELDS,
    id,
    kind: "composite",
    name,
    description: `Composite: ${name}`,
    brickIds,
  };
}

const DEFAULT_OPTIONS: AssembleManifestOptions = {
  name: "test-agent",
  description: "A test agent",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assembleManifest", () => {
  test("generates manifest with tool bricks", async () => {
    const store = createInMemoryForgeStore();
    await store.save(toolBrick("brick_1", "calculator"));
    await store.save(toolBrick("brick_2", "formatter"));

    const result = await assembleManifest(["brick_1", "brick_2"], store, DEFAULT_OPTIONS);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifestYaml).toContain("tools:");
      expect(result.value.manifestYaml).toContain("- name: calculator");
      expect(result.value.manifestYaml).toContain("- name: formatter");
    }
  });

  test("generates manifest with skill bricks", async () => {
    const store = createInMemoryForgeStore();
    await store.save(skillBrick("brick_1", "math-skill"));
    await store.save(skillBrick("brick_2", "code-skill"));

    const result = await assembleManifest(["brick_1", "brick_2"], store, DEFAULT_OPTIONS);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifestYaml).toContain("metadata:");
      expect(result.value.manifestYaml).toContain("skills:");
      expect(result.value.manifestYaml).toContain("- math-skill");
      expect(result.value.manifestYaml).toContain("- code-skill");
    }
  });

  test("generates manifest with mixed bricks (tool + skill)", async () => {
    const store = createInMemoryForgeStore();
    await store.save(toolBrick("brick_1", "calculator"));
    await store.save(skillBrick("brick_2", "math-skill"));

    const result = await assembleManifest(["brick_1", "brick_2"], store, DEFAULT_OPTIONS);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifestYaml).toContain("tools:");
      expect(result.value.manifestYaml).toContain("- name: calculator");
      expect(result.value.manifestYaml).toContain("metadata:");
      expect(result.value.manifestYaml).toContain("- math-skill");
    }
  });

  test("returns error for missing brick", async () => {
    const store = createInMemoryForgeStore();
    await store.save(toolBrick("brick_1", "calculator"));

    const result = await assembleManifest(["brick_1", "brick_missing"], store, DEFAULT_OPTIONS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("brick_missing");
    }
  });

  test("returns error for empty brickIds", async () => {
    const store = createInMemoryForgeStore();

    const result = await assembleManifest([], store, DEFAULT_OPTIONS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MISSING_FIELD");
      expect(result.error.message).toContain("empty");
    }
  });

  test("propagates model option to manifest", async () => {
    const store = createInMemoryForgeStore();
    await store.save(toolBrick("brick_1", "calc"));

    const result = await assembleManifest(["brick_1"], store, {
      ...DEFAULT_OPTIONS,
      model: "claude-sonnet",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifestYaml).toContain("model: claude-sonnet");
    }
  });

  test("propagates agentType option to manifest", async () => {
    const store = createInMemoryForgeStore();
    await store.save(toolBrick("brick_1", "calc"));

    const result = await assembleManifest(["brick_1"], store, {
      ...DEFAULT_OPTIONS,
      agentType: "research",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifestYaml).toContain("agentType: research");
    }
  });

  test("returns loadedBricks matching input count", async () => {
    const store = createInMemoryForgeStore();
    await store.save(toolBrick("brick_1", "calc"));
    await store.save(skillBrick("brick_2", "math"));

    const result = await assembleManifest(["brick_1", "brick_2"], store, DEFAULT_OPTIONS);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.loadedBricks).toHaveLength(2);
    }
  });

  test("includes name and description in manifest", async () => {
    const store = createInMemoryForgeStore();
    await store.save(toolBrick("brick_1", "calc"));

    const result = await assembleManifest(["brick_1"], store, {
      name: "my-agent",
      description: "Does things",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifestYaml).toContain("name: my-agent");
      expect(result.value.manifestYaml).toContain("description: Does things");
    }
  });

  test("handles composite bricks", async () => {
    const store = createInMemoryForgeStore();
    await store.save(compositeBrick("brick_1", "toolkit", ["sub_1", "sub_2"]));

    const result = await assembleManifest(["brick_1"], store, DEFAULT_OPTIONS);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Composite should appear as a comment in tools section
      expect(result.value.manifestYaml).toContain("# composite: toolkit");
    }
  });

  test("quotes description with special characters", async () => {
    const store = createInMemoryForgeStore();
    await store.save(toolBrick("brick_1", "calc"));

    const result = await assembleManifest(["brick_1"], store, {
      name: "agent",
      description: "Agent: does stuff & more",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifestYaml).toContain('"Agent: does stuff & more"');
    }
  });
});
