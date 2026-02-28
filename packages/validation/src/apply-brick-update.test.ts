import { describe, expect, test } from "bun:test";
import type { BrickArtifactBase, BrickFitnessMetrics, BrickUpdate } from "@koi/core";
import { applyBrickUpdate } from "./apply-brick-update.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createBrick(overrides?: Partial<BrickArtifactBase>): BrickArtifactBase {
  return {
    id: `sha256:${"a".repeat(64)}` as BrickArtifactBase["id"],
    kind: "tool",
    name: "test-brick",
    description: "A test brick",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: {
      buildDefinition: { buildType: "forge/v1", externalParameters: {}, internalParameters: {} },
      runDetails: {
        builder: { id: "agent-1", version: "0.0.1" },
        metadata: { agentId: "agent-1", sessionId: "s1", invocationId: "inv1", depth: 0 },
        byProducts: [],
      },
      classification: "internal",
      contentMarkers: [],
    },
    version: "0.0.1",
    tags: ["original"],
    usageCount: 0,
    ...overrides,
  } as BrickArtifactBase;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyBrickUpdate", () => {
  test("returns same shape when updates is empty", () => {
    const brick = createBrick();
    const result = applyBrickUpdate(brick, {});
    expect(result).toEqual(brick);
  });

  test("does not mutate the original brick", () => {
    const brick = createBrick();
    const original = { ...brick };
    applyBrickUpdate(brick, { usageCount: 99 });
    expect(brick).toEqual(original);
  });

  test("returns a new object (not same reference)", () => {
    const brick = createBrick();
    const result = applyBrickUpdate(brick, {});
    expect(result).not.toBe(brick);
  });

  // ---------------------------------------------------------------------------
  // Individual field updates
  // ---------------------------------------------------------------------------

  test("updates lifecycle", () => {
    const brick = createBrick({ lifecycle: "active" });
    const result = applyBrickUpdate(brick, { lifecycle: "deprecated" });
    expect(result.lifecycle).toBe("deprecated");
  });

  test("updates trustTier", () => {
    const brick = createBrick({ trustTier: "sandbox" });
    const result = applyBrickUpdate(brick, { trustTier: "verified" });
    expect(result.trustTier).toBe("verified");
  });

  test("updates scope", () => {
    const brick = createBrick({ scope: "agent" });
    const result = applyBrickUpdate(brick, { scope: "global" });
    expect(result.scope).toBe("global");
  });

  test("updates usageCount", () => {
    const brick = createBrick({ usageCount: 5 });
    const result = applyBrickUpdate(brick, { usageCount: 10 });
    expect(result.usageCount).toBe(10);
  });

  test("updates tags", () => {
    const brick = createBrick({ tags: ["old"] });
    const result = applyBrickUpdate(brick, { tags: ["new", "updated"] });
    expect(result.tags).toEqual(["new", "updated"]);
  });

  test("updates lastVerifiedAt", () => {
    const brick = createBrick();
    const now = Date.now();
    const result = applyBrickUpdate(brick, { lastVerifiedAt: now });
    expect(result.lastVerifiedAt).toBe(now);
  });

  test("updates fitness", () => {
    const brick = createBrick();
    const fitness: BrickFitnessMetrics = {
      successCount: 5,
      errorCount: 1,
      latency: { samples: [100], count: 1, cap: 200 },
      lastUsedAt: Date.now(),
    };
    const result = applyBrickUpdate(brick, { fitness });
    expect(result.fitness).toEqual(fitness);
  });

  test("updates lastPromotedAt", () => {
    const brick = createBrick();
    const now = Date.now();
    const result = applyBrickUpdate(brick, { lastPromotedAt: now });
    expect(result.lastPromotedAt).toBe(now);
  });

  test("updates lastDemotedAt", () => {
    const brick = createBrick();
    const now = Date.now();
    const result = applyBrickUpdate(brick, { lastDemotedAt: now });
    expect(result.lastDemotedAt).toBe(now);
  });

  // ---------------------------------------------------------------------------
  // Multiple fields
  // ---------------------------------------------------------------------------

  test("applies multiple fields at once", () => {
    const brick = createBrick({ usageCount: 0, trustTier: "sandbox" });
    const result = applyBrickUpdate(brick, {
      usageCount: 5,
      trustTier: "verified",
      lifecycle: "deprecated",
    });
    expect(result.usageCount).toBe(5);
    expect(result.trustTier).toBe("verified");
    expect(result.lifecycle).toBe("deprecated");
    // Unmodified fields preserved
    expect(result.name).toBe("test-brick");
    expect(result.scope).toBe("agent");
  });

  // ---------------------------------------------------------------------------
  // Undefined fields are NOT applied
  // ---------------------------------------------------------------------------

  test("undefined fields in update do not override existing values", () => {
    const brick = createBrick({
      usageCount: 5,
      trustTier: "verified",
      tags: ["keep"],
    });
    // Intentionally pass undefined values to verify conditional-spread ignores them.
    // Use double cast because exactOptionalPropertyTypes forbids explicit undefined.
    const updates = {
      usageCount: undefined,
      trustTier: undefined,
      tags: undefined,
    } as unknown as BrickUpdate;
    const result = applyBrickUpdate(brick, updates);
    expect(result.usageCount).toBe(5);
    expect(result.trustTier).toBe("verified");
    expect(result.tags).toEqual(["keep"]);
  });

  // ---------------------------------------------------------------------------
  // Preserves extra fields from subtypes (ToolArtifact, etc.)
  // ---------------------------------------------------------------------------

  test("preserves fields from ToolArtifact subtype", () => {
    const toolBrick = {
      ...createBrick(),
      kind: "tool" as const,
      implementation: "return 42;",
      inputSchema: { type: "object" },
    };
    const result = applyBrickUpdate(toolBrick, { usageCount: 10 });
    expect(result.usageCount).toBe(10);
    expect((result as typeof toolBrick).implementation).toBe("return 42;");
    expect((result as typeof toolBrick).inputSchema).toEqual({ type: "object" });
  });
});
