import { describe, expect, test } from "bun:test";
import type { ToolArtifact } from "@koi/core";
import { filterByAgentScope, isVisibleToAgent } from "./scope-filter.js";

function createBrick(overrides?: Partial<ToolArtifact>): ToolArtifact {
  return {
    id: "brick_test",
    kind: "tool",
    name: "test-brick",
    description: "A test brick",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    createdBy: "agent-1",
    createdAt: Date.now(),
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    contentHash: "test-hash",
    implementation: "return 1;",
    inputSchema: { type: "object" },
    ...overrides,
  };
}

describe("isVisibleToAgent", () => {
  test("returns true for global-scoped bricks", () => {
    const brick = createBrick({ scope: "global", createdBy: "other-agent" });
    expect(isVisibleToAgent(brick, "agent-1")).toBe(true);
  });

  test("returns true for zone-scoped bricks (Phase 2 passthrough)", () => {
    const brick = createBrick({ scope: "zone", createdBy: "other-agent" });
    expect(isVisibleToAgent(brick, "agent-1")).toBe(true);
  });

  test("returns true for agent-scoped brick matching creator", () => {
    const brick = createBrick({ scope: "agent", createdBy: "agent-1" });
    expect(isVisibleToAgent(brick, "agent-1")).toBe(true);
  });

  test("returns false for agent-scoped brick from different agent", () => {
    const brick = createBrick({ scope: "agent", createdBy: "agent-2" });
    expect(isVisibleToAgent(brick, "agent-1")).toBe(false);
  });
});

describe("filterByAgentScope", () => {
  test("filters mixed-scope array correctly", () => {
    const bricks = [
      createBrick({ id: "b1", scope: "global", createdBy: "other" }),
      createBrick({ id: "b2", scope: "agent", createdBy: "agent-1" }),
      createBrick({ id: "b3", scope: "agent", createdBy: "agent-2" }),
      createBrick({ id: "b4", scope: "zone", createdBy: "other" }),
    ];
    const filtered = filterByAgentScope(bricks, "agent-1");
    expect(filtered).toHaveLength(3);
    expect(filtered.map((b) => b.id)).toEqual(["b1", "b2", "b4"]);
  });

  test("returns empty array for empty input", () => {
    expect(filterByAgentScope([], "agent-1")).toHaveLength(0);
  });
});
