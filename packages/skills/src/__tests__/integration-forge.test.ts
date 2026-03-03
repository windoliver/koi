/**
 * Integration tests for mixed-source skill loading (filesystem + forged).
 *
 * Validates that createSkillComponentProvider correctly handles both
 * SkillSource kinds, deduplications, error isolation, and promotion.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type {
  Agent,
  BrickArtifact,
  BrickId,
  ComponentEvent,
  ForgeStore,
  KoiError,
  Result,
  SkillArtifact,
} from "@koi/core";
import { brickId, forgedSkill, fsSkill } from "@koi/core";
import { clearSkillCache } from "../loader.js";
import { clearForgeSkillCache } from "../loader-forge.js";
import { createSkillComponentProvider } from "../provider.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES = resolve(import.meta.dir, "../../fixtures");
const stubAgent = { pid: { id: "integration-forge-test" } } as unknown as Agent;

const TEST_BRICK_ID: BrickId = brickId("sha256:integration-test-001");

const SKILL_CONTENT = [
  "---",
  "name: forged-review",
  "description: A forged code review skill.",
  "allowed-tools: read_file write_file",
  "---",
  "",
  "# Forged Review",
  "",
  "This skill was forged by the agent.",
].join("\n");

function createMockArtifact(overrides?: Partial<SkillArtifact>): SkillArtifact {
  return {
    id: TEST_BRICK_ID,
    kind: "skill",
    name: "forged-review",
    description: "A forged code review skill.",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: {
      builder: { id: "test" },
      buildDefinition: { buildType: "forge" },
      runMetadata: {},
    },
    version: "1.0.0",
    tags: ["read_file", "write_file"],
    usageCount: 0,
    content: SKILL_CONTENT,
    ...overrides,
  } as SkillArtifact;
}

function mockForgeStore(artifacts: ReadonlyMap<string, BrickArtifact>): ForgeStore {
  return {
    load: async (id: BrickId): Promise<Result<BrickArtifact, KoiError>> => {
      const artifact = artifacts.get(id);
      if (artifact === undefined) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Brick ${id} not found`,
            retryable: false,
            context: { brickId: id },
          },
        };
      }
      return { ok: true, value: artifact };
    },
    save: async () => ({ ok: true, value: undefined }),
    search: async () => ({ ok: true, value: [] }),
    remove: async () => ({ ok: true, value: undefined }),
    update: async () => ({ ok: true, value: undefined }),
    watch: () => () => {},
  } as unknown as ForgeStore;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearForgeSkillCache();
  clearSkillCache();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mixed-source skill loading", () => {
  test("attaches filesystem + forged skills together at metadata level", async () => {
    const artifact = createMockArtifact();
    const store = mockForgeStore(new Map([[TEST_BRICK_ID, artifact]]));

    const provider = createSkillComponentProvider({
      skills: [
        fsSkill("code-review", "./valid-skill"),
        fsSkill("minimal-skill", "./minimal-skill"),
        forgedSkill("forged-review", TEST_BRICK_ID),
      ],
      basePath: FIXTURES,
      store,
    });

    const result = await provider.attach(stubAgent);
    if (!("components" in result)) {
      throw new Error("Expected attach to return components");
    }

    expect(result.components.size).toBe(3);
    expect(result.components.has("skill:code-review")).toBe(true);
    expect(result.components.has("skill:minimal")).toBe(true);
    expect(result.components.has("skill:forged-review")).toBe(true);
    expect(result.skipped).toHaveLength(0);

    // All start at metadata level
    expect(provider.getLevel("code-review")).toBe("metadata");
    expect(provider.getLevel("forged-review")).toBe("metadata");
  });

  test("promotes forged skill to body level", async () => {
    const artifact = createMockArtifact();
    const store = mockForgeStore(new Map([[TEST_BRICK_ID, artifact]]));

    const provider = createSkillComponentProvider({
      skills: [forgedSkill("forged-review", TEST_BRICK_ID)],
      basePath: FIXTURES,
      store,
    });

    await provider.attach(stubAgent);

    const promoteResult = await provider.promote("forged-review", "body");
    expect(promoteResult.ok).toBe(true);
    expect(provider.getLevel("forged-review")).toBe("body");
  });

  test("promotes filesystem skill to body level alongside forged skill", async () => {
    const artifact = createMockArtifact();
    const store = mockForgeStore(new Map([[TEST_BRICK_ID, artifact]]));

    const provider = createSkillComponentProvider({
      skills: [
        fsSkill("code-review", "./valid-skill"),
        forgedSkill("forged-review", TEST_BRICK_ID),
      ],
      basePath: FIXTURES,
      store,
    });

    const attachResult = await provider.attach(stubAgent);
    if (!("components" in attachResult)) {
      throw new Error("Expected attach to return components");
    }

    // Promote filesystem skill
    const fsPromote = await provider.promote("code-review", "body");
    expect(fsPromote.ok).toBe(true);
    expect(provider.getLevel("code-review")).toBe("body");

    // Verify forged skill still at metadata
    expect(provider.getLevel("forged-review")).toBe("metadata");

    // Promote forged skill
    const forgePromote = await provider.promote("forged-review", "body");
    expect(forgePromote.ok).toBe(true);
    expect(provider.getLevel("forged-review")).toBe("body");
  });

  test("duplicate name across sources — first-wins (declaration order)", async () => {
    const artifact = createMockArtifact({
      name: "code-review",
      description: "Forged version of code-review.",
    });
    const store = mockForgeStore(new Map([[TEST_BRICK_ID, artifact]]));

    const provider = createSkillComponentProvider({
      skills: [fsSkill("code-review", "./valid-skill"), forgedSkill("code-review", TEST_BRICK_ID)],
      basePath: FIXTURES,
      store,
    });

    const result = await provider.attach(stubAgent);
    if (!("components" in result)) {
      throw new Error("Expected attach to return components");
    }

    // Only 1 component — first definition wins
    expect(result.components.size).toBe(1);
    expect(result.components.has("skill:code-review")).toBe(true);

    // Duplicate is skipped
    expect(result.skipped.length).toBeGreaterThanOrEqual(1);
    const skippedNames = result.skipped.map((s) => s.name);
    expect(skippedNames).toContain("code-review");
  });

  test("forge skill load failure does not block filesystem skills", async () => {
    // Empty store — forged skill will fail to load
    const store = mockForgeStore(new Map());

    const provider = createSkillComponentProvider({
      skills: [
        fsSkill("code-review", "./valid-skill"),
        forgedSkill("missing-forged", brickId("sha256:nonexistent")),
      ],
      basePath: FIXTURES,
      store,
    });

    const result = await provider.attach(stubAgent);
    if (!("components" in result)) {
      throw new Error("Expected attach to return components");
    }

    // Filesystem skill loads fine
    expect(result.components.has("skill:code-review")).toBe(true);

    // Forged skill is skipped
    const skippedNames = result.skipped.map((s) => s.name);
    expect(skippedNames).toContain("missing-forged");
  });

  test("throws when forged skills exist but no ForgeStore provided", () => {
    expect(() => {
      createSkillComponentProvider({
        skills: [forgedSkill("forged-review", TEST_BRICK_ID)],
        basePath: FIXTURES,
      });
    }).toThrow("SkillConfig contains forged skills but no ForgeStore was provided");
  });

  test("all-forge provider works without filesystem skills", async () => {
    const artifact = createMockArtifact();
    const store = mockForgeStore(new Map([[TEST_BRICK_ID, artifact]]));

    const provider = createSkillComponentProvider({
      skills: [forgedSkill("forged-review", TEST_BRICK_ID)],
      basePath: FIXTURES,
      store,
    });

    const result = await provider.attach(stubAgent);
    if (!("components" in result)) {
      throw new Error("Expected attach to return components");
    }

    expect(result.components.size).toBe(1);
    expect(result.components.has("skill:forged-review")).toBe(true);
    expect(result.skipped).toHaveLength(0);
  });

  test("watch fires on forge skill promotion", async () => {
    const artifact = createMockArtifact();
    const store = mockForgeStore(new Map([[TEST_BRICK_ID, artifact]]));

    const provider = createSkillComponentProvider({
      skills: [forgedSkill("forged-review", TEST_BRICK_ID)],
      basePath: FIXTURES,
      store,
    });

    await provider.attach(stubAgent);

    const events: ComponentEvent[] = [];
    provider.watch((event) => {
      events.push(event);
    });

    await provider.promote("forged-review", "body");

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("attached");
    expect(events[0]?.componentKey).toBe("skill:forged-review");
  });
});
