import { describe, expect, test } from "bun:test";
import type { BrickArtifactBase, ForgeQuery } from "@koi/core";
import { brickId, DEFAULT_SANDBOXED_POLICY, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import { matchesBrickQuery } from "./query-match.js";

function createBrickBase(overrides?: Partial<BrickArtifactBase>): BrickArtifactBase {
  return {
    id: brickId("brick_test-001"),
    kind: "tool",
    name: "test-tool",
    description: "A test tool for unit tests",
    scope: "agent",
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: ["util", "test"],
    usageCount: 0,
    ...overrides,
  };
}

describe("matchesBrickQuery", () => {
  test("returns true for empty query (matches everything)", () => {
    expect(matchesBrickQuery(createBrickBase(), {})).toBe(true);
  });

  test("filters by kind", () => {
    const brick = createBrickBase({ kind: "tool" });
    expect(matchesBrickQuery(brick, { kind: "tool" })).toBe(true);
    expect(matchesBrickQuery(brick, { kind: "skill" })).toBe(false);
  });

  test("filters by scope", () => {
    const brick = createBrickBase({ scope: "agent" });
    expect(matchesBrickQuery(brick, { scope: "agent" })).toBe(true);
    expect(matchesBrickQuery(brick, { scope: "global" })).toBe(false);
  });

  test("filters by sandbox", () => {
    const brick = createBrickBase({ policy: DEFAULT_UNSANDBOXED_POLICY });
    expect(matchesBrickQuery(brick, { sandbox: false })).toBe(true);
    expect(matchesBrickQuery(brick, { sandbox: true })).toBe(false);
  });

  test("filters by lifecycle", () => {
    const brick = createBrickBase({ lifecycle: "active" });
    expect(matchesBrickQuery(brick, { lifecycle: "active" })).toBe(true);
    expect(matchesBrickQuery(brick, { lifecycle: "deprecated" })).toBe(false);
  });

  test("filters by createdBy (provenance.metadata.agentId)", () => {
    const brick = createBrickBase();
    expect(matchesBrickQuery(brick, { createdBy: "agent-1" })).toBe(true);
    expect(matchesBrickQuery(brick, { createdBy: "agent-999" })).toBe(false);
  });

  test("filters by classification", () => {
    const brick = createBrickBase();
    // DEFAULT_PROVENANCE.classification === "public"
    expect(matchesBrickQuery(brick, { classification: "public" })).toBe(true);
    expect(matchesBrickQuery(brick, { classification: "secret" })).toBe(false);
  });

  test("filters by contentMarkers (AND-subset)", () => {
    const brick = createBrickBase({
      provenance: { ...DEFAULT_PROVENANCE, contentMarkers: ["pii", "credentials"] },
    });
    expect(matchesBrickQuery(brick, { contentMarkers: ["pii"] })).toBe(true);
    expect(matchesBrickQuery(brick, { contentMarkers: ["pii", "credentials"] })).toBe(true);
    expect(matchesBrickQuery(brick, { contentMarkers: ["pii", "payment"] })).toBe(false);
  });

  test("skips contentMarkers filter when empty array", () => {
    const brick = createBrickBase();
    expect(matchesBrickQuery(brick, { contentMarkers: [] })).toBe(true);
  });

  test("filters by tags (AND-subset)", () => {
    const brick = createBrickBase({ tags: ["util", "test", "fast"] });
    expect(matchesBrickQuery(brick, { tags: ["util"] })).toBe(true);
    expect(matchesBrickQuery(brick, { tags: ["util", "test"] })).toBe(true);
    expect(matchesBrickQuery(brick, { tags: ["util", "missing"] })).toBe(false);
  });

  test("skips tags filter when empty array", () => {
    const brick = createBrickBase({ tags: [] });
    expect(matchesBrickQuery(brick, { tags: [] })).toBe(true);
  });

  test("filters by text (case-insensitive substring on name)", () => {
    const brick = createBrickBase({ name: "JSON Parser" });
    expect(matchesBrickQuery(brick, { text: "json" })).toBe(true);
    expect(matchesBrickQuery(brick, { text: "JSON" })).toBe(true);
    expect(matchesBrickQuery(brick, { text: "xml" })).toBe(false);
  });

  test("filters by text (case-insensitive substring on description)", () => {
    const brick = createBrickBase({ description: "Parses JSON data into objects" });
    expect(matchesBrickQuery(brick, { text: "json data" })).toBe(true);
    expect(matchesBrickQuery(brick, { text: "xml data" })).toBe(false);
  });

  test("skips text filter when empty string", () => {
    const brick = createBrickBase();
    expect(matchesBrickQuery(brick, { text: "" })).toBe(true);
  });

  test("text filter also matches trigger patterns", () => {
    const brick = createBrickBase({
      name: "chart-tool",
      description: "Creates charts",
      trigger: ["visualize data", "plot graph"],
    });
    // Matches via trigger, not name or description
    expect(matchesBrickQuery(brick, { text: "plot" })).toBe(true);
    // Matches via name
    expect(matchesBrickQuery(brick, { text: "chart" })).toBe(true);
    // No match anywhere
    expect(matchesBrickQuery(brick, { text: "spreadsheet" })).toBe(false);
  });

  test("combines multiple filters (AND semantics)", () => {
    const brick = createBrickBase({
      kind: "tool",
      scope: "global",
      policy: DEFAULT_UNSANDBOXED_POLICY,
      tags: ["production"],
    });
    expect(
      matchesBrickQuery(brick, {
        kind: "tool",
        scope: "global",
        sandbox: false,
        tags: ["production"],
      }),
    ).toBe(true);
    expect(
      matchesBrickQuery(brick, {
        kind: "tool",
        scope: "global",
        sandbox: true, // mismatch
      }),
    ).toBe(false);
  });

  test("ignores undefined query fields", () => {
    const brick = createBrickBase();
    // Empty object — all optional fields are absent (not explicitly undefined)
    const query: ForgeQuery = {};
    expect(matchesBrickQuery(brick, query)).toBe(true);
  });

  // --- triggerText matching ---

  test("filters by triggerText (case-insensitive substring on trigger array)", () => {
    const brick = createBrickBase({
      trigger: ["visualize theorem", "animate proof", "mathematical explanation video"],
    });
    expect(matchesBrickQuery(brick, { triggerText: "animate" })).toBe(true);
    expect(matchesBrickQuery(brick, { triggerText: "VISUALIZE" })).toBe(true);
    expect(matchesBrickQuery(brick, { triggerText: "explanation" })).toBe(true);
    expect(matchesBrickQuery(brick, { triggerText: "spreadsheet" })).toBe(false);
  });

  test("triggerText returns false when brick has no triggers", () => {
    const brick = createBrickBase();
    expect(matchesBrickQuery(brick, { triggerText: "anything" })).toBe(false);
  });

  test("triggerText returns false when brick has empty trigger array", () => {
    const brick = createBrickBase({ trigger: [] });
    expect(matchesBrickQuery(brick, { triggerText: "anything" })).toBe(false);
  });

  test("skips triggerText filter when empty string", () => {
    const brick = createBrickBase();
    expect(matchesBrickQuery(brick, { triggerText: "" })).toBe(true);
  });

  test("triggerText combines with other filters (AND semantics)", () => {
    const brick = createBrickBase({
      kind: "skill",
      trigger: ["visualize data", "create chart"],
    });
    expect(matchesBrickQuery(brick, { kind: "skill", triggerText: "visualize" })).toBe(true);
    expect(matchesBrickQuery(brick, { kind: "tool", triggerText: "visualize" })).toBe(false);
  });
});
