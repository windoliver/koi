import { describe, expect, test } from "bun:test";
import type { BrickArtifactBase } from "@koi/core";
import { brickId } from "@koi/core";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import { matchesBrickQuery } from "./query.js";

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

describe("matchesBrickQuery", () => {
  test("empty query matches all", () => {
    expect(matchesBrickQuery(baseBrick(), {})).toBe(true);
  });

  test("filters by kind", () => {
    expect(matchesBrickQuery(baseBrick({ kind: "tool" }), { kind: "tool" })).toBe(true);
    expect(matchesBrickQuery(baseBrick({ kind: "tool" }), { kind: "skill" })).toBe(false);
  });

  test("filters by scope", () => {
    expect(matchesBrickQuery(baseBrick({ scope: "global" }), { scope: "global" })).toBe(true);
    expect(matchesBrickQuery(baseBrick({ scope: "agent" }), { scope: "global" })).toBe(false);
  });

  test("filters by trustTier", () => {
    expect(matchesBrickQuery(baseBrick({ trustTier: "verified" }), { trustTier: "verified" })).toBe(
      true,
    );
    expect(matchesBrickQuery(baseBrick({ trustTier: "sandbox" }), { trustTier: "verified" })).toBe(
      false,
    );
  });

  test("filters by lifecycle", () => {
    expect(matchesBrickQuery(baseBrick({ lifecycle: "active" }), { lifecycle: "active" })).toBe(
      true,
    );
    expect(matchesBrickQuery(baseBrick({ lifecycle: "draft" }), { lifecycle: "active" })).toBe(
      false,
    );
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
      matchesBrickQuery(baseBrick({ provenance: agent1Provenance }), { createdBy: "agent-1" }),
    ).toBe(true);
    expect(
      matchesBrickQuery(baseBrick({ provenance: agent2Provenance }), { createdBy: "agent-1" }),
    ).toBe(false);
  });

  test("tags use AND-subset matching", () => {
    const brick = baseBrick({ tags: ["math", "calc", "utility"] });
    expect(matchesBrickQuery(brick, { tags: ["math"] })).toBe(true);
    expect(matchesBrickQuery(brick, { tags: ["math", "calc"] })).toBe(true);
    expect(matchesBrickQuery(brick, { tags: ["math", "missing"] })).toBe(false);
  });

  test("empty tags query matches all", () => {
    expect(matchesBrickQuery(baseBrick({ tags: [] }), { tags: [] })).toBe(true);
  });

  test("text search is case-insensitive on name", () => {
    expect(matchesBrickQuery(baseBrick({ name: "Calculator" }), { text: "calc" })).toBe(true);
    expect(matchesBrickQuery(baseBrick({ name: "Calculator" }), { text: "CALC" })).toBe(true);
  });

  test("text search matches description", () => {
    expect(matchesBrickQuery(baseBrick({ description: "A math utility" }), { text: "math" })).toBe(
      true,
    );
  });

  test("text search returns false when no match", () => {
    expect(matchesBrickQuery(baseBrick({ name: "abc", description: "def" }), { text: "xyz" })).toBe(
      false,
    );
  });

  test("multiple filters combine with AND", () => {
    const brick = baseBrick({ kind: "tool", scope: "global", lifecycle: "active" });
    expect(matchesBrickQuery(brick, { kind: "tool", scope: "global" })).toBe(true);
    expect(matchesBrickQuery(brick, { kind: "tool", scope: "agent" })).toBe(false);
  });
});
