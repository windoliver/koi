import { describe, expect, test } from "bun:test";
import type { BrickArtifactBase } from "@koi/core";
import { brickId } from "@koi/core";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import { matchesQuery } from "./query.js";

function baseBrick(overrides?: Partial<BrickArtifactBase>): BrickArtifactBase {
  return {
    id: brickId("test-id"),
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
    ...overrides,
  };
}

describe("matchesQuery", () => {
  test("empty query matches all", () => {
    expect(matchesQuery(baseBrick(), {})).toBe(true);
  });

  test("filters by kind", () => {
    expect(matchesQuery(baseBrick({ kind: "tool" }), { kind: "tool" })).toBe(true);
    expect(matchesQuery(baseBrick({ kind: "tool" }), { kind: "skill" })).toBe(false);
  });

  test("filters by scope", () => {
    expect(matchesQuery(baseBrick({ scope: "global" }), { scope: "global" })).toBe(true);
    expect(matchesQuery(baseBrick({ scope: "agent" }), { scope: "global" })).toBe(false);
  });

  test("filters by trustTier", () => {
    expect(matchesQuery(baseBrick({ trustTier: "verified" }), { trustTier: "verified" })).toBe(
      true,
    );
    expect(matchesQuery(baseBrick({ trustTier: "sandbox" }), { trustTier: "verified" })).toBe(
      false,
    );
  });

  test("filters by lifecycle", () => {
    expect(matchesQuery(baseBrick({ lifecycle: "active" }), { lifecycle: "active" })).toBe(true);
    expect(matchesQuery(baseBrick({ lifecycle: "draft" }), { lifecycle: "active" })).toBe(false);
  });

  test("filters by createdBy (provenance.metadata.agentId)", () => {
    const agent1Provenance = {
      ...DEFAULT_PROVENANCE,
      metadata: { ...DEFAULT_PROVENANCE.metadata, agentId: "agent-1" },
    };
    const agent2Provenance = {
      ...DEFAULT_PROVENANCE,
      metadata: { ...DEFAULT_PROVENANCE.metadata, agentId: "agent-2" },
    };
    expect(
      matchesQuery(baseBrick({ provenance: agent1Provenance }), { createdBy: "agent-1" }),
    ).toBe(true);
    expect(
      matchesQuery(baseBrick({ provenance: agent2Provenance }), { createdBy: "agent-1" }),
    ).toBe(false);
  });

  test("tags use AND-subset matching", () => {
    const brick = baseBrick({ tags: ["math", "calc", "utility"] });
    expect(matchesQuery(brick, { tags: ["math"] })).toBe(true);
    expect(matchesQuery(brick, { tags: ["math", "calc"] })).toBe(true);
    expect(matchesQuery(brick, { tags: ["math", "missing"] })).toBe(false);
  });

  test("empty tags query matches all", () => {
    expect(matchesQuery(baseBrick({ tags: [] }), { tags: [] })).toBe(true);
  });

  test("text search is case-insensitive on name", () => {
    expect(matchesQuery(baseBrick({ name: "Calculator" }), { text: "calc" })).toBe(true);
    expect(matchesQuery(baseBrick({ name: "Calculator" }), { text: "CALC" })).toBe(true);
  });

  test("text search matches description", () => {
    expect(matchesQuery(baseBrick({ description: "A math utility" }), { text: "math" })).toBe(true);
  });

  test("text search returns false when no match", () => {
    expect(matchesQuery(baseBrick({ name: "abc", description: "def" }), { text: "xyz" })).toBe(
      false,
    );
  });

  test("multiple filters combine with AND", () => {
    const brick = baseBrick({ kind: "tool", scope: "global", lifecycle: "active" });
    expect(matchesQuery(brick, { kind: "tool", scope: "global" })).toBe(true);
    expect(matchesQuery(brick, { kind: "tool", scope: "agent" })).toBe(false);
  });
});
