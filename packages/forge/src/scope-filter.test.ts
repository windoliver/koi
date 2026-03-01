import { describe, expect, test } from "bun:test";
import type { ToolArtifact } from "@koi/core";
import { brickId } from "@koi/core";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import { filterByAgentScope, isVisibleToAgent } from "./scope-filter.js";

function createBrick(overrides?: Partial<ToolArtifact>): ToolArtifact {
  return {
    id: brickId("brick_test"),
    kind: "tool",
    name: "test-brick",
    description: "A test brick",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    implementation: "return 1;",
    inputSchema: { type: "object" },
    ...overrides,
  };
}

describe("isVisibleToAgent", () => {
  test("returns true for global-scoped bricks", () => {
    const brick = createBrick({
      scope: "global",
      provenance: {
        ...DEFAULT_PROVENANCE,
        metadata: { ...DEFAULT_PROVENANCE.metadata, agentId: "other-agent" },
      },
    });
    expect(isVisibleToAgent(brick, "agent-1")).toBe(true);
  });

  test("returns true for zone-scoped bricks when no zoneId provided (backward compat)", () => {
    const brick = createBrick({
      scope: "zone",
      provenance: {
        ...DEFAULT_PROVENANCE,
        metadata: { ...DEFAULT_PROVENANCE.metadata, agentId: "other-agent" },
      },
    });
    expect(isVisibleToAgent(brick, "agent-1")).toBe(true);
  });

  test("returns true for zone-scoped brick with matching zone tag", () => {
    const brick = createBrick({
      scope: "zone",
      tags: ["zone:us-east-1"],
      provenance: {
        ...DEFAULT_PROVENANCE,
        metadata: { ...DEFAULT_PROVENANCE.metadata, agentId: "other-agent" },
      },
    });
    expect(isVisibleToAgent(brick, "agent-1", "us-east-1")).toBe(true);
  });

  test("returns false for zone-scoped brick with mismatching zone tag", () => {
    const brick = createBrick({
      scope: "zone",
      tags: ["zone:us-west-2"],
      provenance: {
        ...DEFAULT_PROVENANCE,
        metadata: { ...DEFAULT_PROVENANCE.metadata, agentId: "other-agent" },
      },
    });
    expect(isVisibleToAgent(brick, "agent-1", "us-east-1")).toBe(false);
  });

  test("returns true for agent-scoped brick matching creator", () => {
    const brick = createBrick({
      scope: "agent",
      provenance: {
        ...DEFAULT_PROVENANCE,
        metadata: { ...DEFAULT_PROVENANCE.metadata, agentId: "agent-1" },
      },
    });
    expect(isVisibleToAgent(brick, "agent-1")).toBe(true);
  });

  test("returns false for agent-scoped brick from different agent", () => {
    const brick = createBrick({
      scope: "agent",
      provenance: {
        ...DEFAULT_PROVENANCE,
        metadata: { ...DEFAULT_PROVENANCE.metadata, agentId: "agent-2" },
      },
    });
    expect(isVisibleToAgent(brick, "agent-1")).toBe(false);
  });
});

describe("filterByAgentScope", () => {
  test("filters mixed-scope array correctly", () => {
    const bricks = [
      createBrick({
        id: brickId("b1"),
        scope: "global",
        provenance: {
          ...DEFAULT_PROVENANCE,
          metadata: { ...DEFAULT_PROVENANCE.metadata, agentId: "other" },
        },
      }),
      createBrick({
        id: brickId("b2"),
        scope: "agent",
        provenance: {
          ...DEFAULT_PROVENANCE,
          metadata: { ...DEFAULT_PROVENANCE.metadata, agentId: "agent-1" },
        },
      }),
      createBrick({
        id: brickId("b3"),
        scope: "agent",
        provenance: {
          ...DEFAULT_PROVENANCE,
          metadata: { ...DEFAULT_PROVENANCE.metadata, agentId: "agent-2" },
        },
      }),
      createBrick({
        id: brickId("b4"),
        scope: "zone",
        provenance: {
          ...DEFAULT_PROVENANCE,
          metadata: { ...DEFAULT_PROVENANCE.metadata, agentId: "other" },
        },
      }),
    ];
    const filtered = filterByAgentScope(bricks, "agent-1");
    expect(filtered).toHaveLength(3);
    expect(filtered.map((b) => b.id)).toEqual([brickId("b1"), brickId("b2"), brickId("b4")]);
  });

  test("returns empty array for empty input", () => {
    expect(filterByAgentScope([], "agent-1")).toHaveLength(0);
  });

  test("filters zone-scoped bricks by zoneId", () => {
    const bricks = [
      createBrick({
        id: brickId("b1"),
        scope: "zone",
        tags: ["zone:us-east-1"],
        provenance: {
          ...DEFAULT_PROVENANCE,
          metadata: { ...DEFAULT_PROVENANCE.metadata, agentId: "other" },
        },
      }),
      createBrick({
        id: brickId("b2"),
        scope: "zone",
        tags: ["zone:us-west-2"],
        provenance: {
          ...DEFAULT_PROVENANCE,
          metadata: { ...DEFAULT_PROVENANCE.metadata, agentId: "other" },
        },
      }),
      createBrick({
        id: brickId("b3"),
        scope: "global",
        provenance: {
          ...DEFAULT_PROVENANCE,
          metadata: { ...DEFAULT_PROVENANCE.metadata, agentId: "other" },
        },
      }),
    ];
    const filtered = filterByAgentScope(bricks, "agent-1", "us-east-1");
    expect(filtered).toHaveLength(2);
    expect(filtered.map((b) => b.id)).toEqual([brickId("b1"), brickId("b3")]);
  });
});
