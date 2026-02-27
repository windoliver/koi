/**
 * Brick resolver utility tests — shared resolution and invalidation helpers.
 */

import { describe, expect, test } from "bun:test";
import type { BrickArtifact, ForgeScope, StoreChangeEvent } from "@koi/core";
import {
  createDeltaInvalidator,
  mapBrickToComponent,
  meetsKindTrust,
  meetsMinTrust,
} from "./brick-resolver.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeBrick(
  overrides: Partial<BrickArtifact> & { readonly kind: BrickArtifact["kind"] },
): BrickArtifact {
  const base = {
    id: "sha256:0000000000000000000000000000000000000000000000000000000000000000" as BrickArtifact["id"],
    name: "test-brick",
    description: "A test brick",
    scope: "agent" as const,
    trustTier: "sandbox" as const,
    lifecycle: "active" as const,
    provenance: {
      agentId: "agent-1",
      sessionId: "session-1",
      forgedAt: 1000,
      classification: "none" as const,
      contentMarkers: [] as readonly string[],
      metadata: { agentId: "agent-1" },
    },
    version: "1.0.0",
    tags: [] as readonly string[],
    usageCount: 0,
  };

  switch (overrides.kind) {
    case "tool":
      return {
        ...base,
        implementation: "return 42;",
        inputSchema: {},
        ...overrides,
        kind: "tool" as const,
      } as BrickArtifact;
    case "skill":
      return {
        ...base,
        content: "# Test skill",
        ...overrides,
        kind: "skill" as const,
      } as BrickArtifact;
    case "agent":
      return {
        ...base,
        manifestYaml: "name: test",
        ...overrides,
        kind: "agent" as const,
      } as BrickArtifact;
    case "middleware":
      return {
        ...base,
        implementation: "export default {};",
        ...overrides,
        kind: "middleware" as const,
      } as BrickArtifact;
    case "channel":
      return {
        ...base,
        implementation: "export default {};",
        ...overrides,
        kind: "channel" as const,
      } as BrickArtifact;
  }
}

// ---------------------------------------------------------------------------
// Trust tier tests
// ---------------------------------------------------------------------------

describe("meetsMinTrust", () => {
  test("sandbox meets sandbox", () => {
    expect(meetsMinTrust("sandbox", "sandbox")).toBe(true);
  });

  test("promoted meets sandbox", () => {
    expect(meetsMinTrust("promoted", "sandbox")).toBe(true);
  });

  test("sandbox does not meet verified", () => {
    expect(meetsMinTrust("sandbox", "verified")).toBe(false);
  });

  test("verified meets verified", () => {
    expect(meetsMinTrust("verified", "verified")).toBe(true);
  });
});

describe("meetsKindTrust", () => {
  test("sandbox tool meets minimum", () => {
    const brick = makeBrick({ kind: "tool", trustTier: "sandbox" });
    expect(meetsKindTrust(brick)).toBe(true);
  });

  test("sandbox middleware may not meet minimum", () => {
    const brick = makeBrick({ kind: "middleware", trustTier: "sandbox" });
    // MIN_TRUST_BY_KIND["middleware"] is "promoted" — sandbox doesn't meet it
    expect(meetsKindTrust(brick)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Brick → component mapping tests
// ---------------------------------------------------------------------------

describe("mapBrickToComponent", () => {
  test("maps skill artifact to SkillComponent", () => {
    const brick = makeBrick({ kind: "skill", name: "test-skill" });
    const component = mapBrickToComponent(brick);
    expect(component).toBeDefined();
    expect((component as { name: string }).name).toBe("test-skill");
  });

  test("maps skill with tags", () => {
    const brick = makeBrick({ kind: "skill", tags: ["tag1", "tag2"] });
    const component = mapBrickToComponent(brick) as { tags?: readonly string[] };
    expect(component?.tags).toEqual(["tag1", "tag2"]);
  });

  test("maps skill without tags omits tags field", () => {
    const brick = makeBrick({ kind: "skill", tags: [] });
    const component = mapBrickToComponent(brick) as unknown as Record<string, unknown>;
    expect(component).not.toHaveProperty("tags");
  });

  test("maps agent artifact to AgentDescriptor", () => {
    const brick = makeBrick({ kind: "agent", name: "test-agent" });
    const component = mapBrickToComponent(brick);
    expect(component).toBeDefined();
    expect((component as { name: string }).name).toBe("test-agent");
    expect((component as { manifestYaml: string }).manifestYaml).toBe("name: test");
  });

  test("maps middleware artifact to itself", () => {
    const brick = makeBrick({ kind: "middleware" });
    const component = mapBrickToComponent(brick);
    expect(component as unknown).toBe(brick);
  });

  test("maps channel artifact to itself", () => {
    const brick = makeBrick({ kind: "channel" });
    const component = mapBrickToComponent(brick);
    expect(component as unknown).toBe(brick);
  });
});

// ---------------------------------------------------------------------------
// Delta invalidation tests
// ---------------------------------------------------------------------------

describe("createDeltaInvalidator", () => {
  const invalidator = createDeltaInvalidator<BrickArtifact>();

  describe("classifyEvent", () => {
    test("saved event → full invalidation", () => {
      const event: StoreChangeEvent = {
        kind: "saved",
        brickId: "sha256:abc" as StoreChangeEvent["brickId"],
      };
      expect(invalidator.classifyEvent(event)).toBe("full");
    });

    test("removed event → delta invalidation", () => {
      const event: StoreChangeEvent = {
        kind: "removed",
        brickId: "sha256:abc" as StoreChangeEvent["brickId"],
      };
      expect(invalidator.classifyEvent(event)).toBe("delta");
    });

    test("updated event → delta invalidation", () => {
      const event: StoreChangeEvent = {
        kind: "updated",
        brickId: "sha256:abc" as StoreChangeEvent["brickId"],
      };
      expect(invalidator.classifyEvent(event)).toBe("delta");
    });

    test("promoted event → delta invalidation", () => {
      const event: StoreChangeEvent = {
        kind: "promoted",
        brickId: "sha256:abc" as StoreChangeEvent["brickId"],
      };
      expect(invalidator.classifyEvent(event)).toBe("delta");
    });
  });

  describe("invalidateByBrickId", () => {
    test("removes matching brick from cache", () => {
      const brick = makeBrick({ kind: "tool", name: "my-tool" });
      const cache = new Map<string, BrickArtifact>();
      cache.set("my-tool", brick);

      const removed = invalidator.invalidateByBrickId(brick.id, cache);
      expect(removed).toBe(true);
      expect(cache.size).toBe(0);
    });

    test("returns false when brick not in cache", () => {
      const cache = new Map<string, BrickArtifact>();
      const removed = invalidator.invalidateByBrickId(
        "sha256:nonexistent" as BrickArtifact["id"],
        cache,
      );
      expect(removed).toBe(false);
    });

    test("does not remove non-matching bricks", () => {
      const brick1 = makeBrick({ kind: "tool", name: "tool-1" });
      const brick2 = makeBrick({
        kind: "tool",
        name: "tool-2",
        id: "sha256:1111111111111111111111111111111111111111111111111111111111111111" as BrickArtifact["id"],
      });
      const cache = new Map<string, BrickArtifact>();
      cache.set("tool-1", brick1);
      cache.set("tool-2", brick2);

      invalidator.invalidateByBrickId(brick1.id, cache);
      expect(cache.size).toBe(1);
      expect(cache.has("tool-2")).toBe(true);
    });
  });

  describe("invalidateByScope", () => {
    test("returns true when scope matches", () => {
      const tracker = new Map<string, ForgeScope>();
      tracker.set("brick-1", "agent");
      tracker.set("brick-2", "global");

      expect(invalidator.invalidateByScope("agent", tracker)).toBe(true);
    });

    test("returns false when scope not found", () => {
      const tracker = new Map<string, ForgeScope>();
      tracker.set("brick-1", "agent");

      expect(invalidator.invalidateByScope("global", tracker)).toBe(false);
    });

    test("returns false for empty tracker", () => {
      const tracker = new Map<string, ForgeScope>();
      expect(invalidator.invalidateByScope("agent", tracker)).toBe(false);
    });
  });
});
