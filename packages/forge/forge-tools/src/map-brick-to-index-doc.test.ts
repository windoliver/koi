/**
 * Tests for mapBrickToIndexDoc — BrickArtifact → IndexDocument mapping.
 */

import { describe, expect, test } from "bun:test";
import { brickId } from "@koi/core";
import {
  createTestAgentArtifact,
  createTestSkillArtifact,
  createTestToolArtifact,
} from "@koi/test-utils";
import { mapBrickToIndexDoc } from "./map-brick-to-index-doc.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mapBrickToIndexDoc", () => {
  test("maps tool brick with inputSchema property keys", () => {
    const brick = createTestToolArtifact({
      id: brickId("tool1"),
      name: "my-tool",
      description: "A useful tool",
      tags: ["data", "transform"],
      inputSchema: {
        type: "object",
        properties: { input: { type: "string" }, format: { type: "string" } },
      },
    });
    const doc = mapBrickToIndexDoc(brick);

    expect(doc.id).toBe(brick.id);
    expect(doc.content).toContain("my-tool");
    expect(doc.content).toContain("A useful tool");
    expect(doc.content).toContain("data transform");
    expect(doc.content).toContain("input format");
    expect(doc.metadata).toEqual({
      kind: "tool",
      scope: "agent",
      lifecycle: "active",
      tags: ["data", "transform"],
    });
  });

  test("maps skill brick with SKILL.md first paragraph", () => {
    const brick = createTestSkillArtifact({
      id: brickId("skill1"),
      name: "my-skill",
      description: "A useful skill",
      files: {
        "SKILL.md": "This skill helps visualize data.\n\nMore details here.\n\nEven more.",
      },
    });
    const doc = mapBrickToIndexDoc(brick);

    expect(doc.content).toContain("This skill helps visualize data.");
    expect(doc.content).not.toContain("More details here");
  });

  test("maps skill brick without files", () => {
    const brick = createTestSkillArtifact({
      id: brickId("skill2"),
      name: "my-skill",
      description: "A useful skill",
    });
    const doc = mapBrickToIndexDoc(brick);

    expect(doc.content).toContain("my-skill");
    expect(doc.content).toContain("A useful skill");
  });

  test("maps agent brick (name + description + tags only)", () => {
    const brick = createTestAgentArtifact({
      id: brickId("agent1"),
      name: "my-agent",
      description: "A helpful agent",
      scope: "zone",
      tags: ["auto"],
    });
    const doc = mapBrickToIndexDoc(brick);

    expect(doc.content).toContain("my-agent");
    expect(doc.content).toContain("A helpful agent");
    expect(doc.content).toContain("auto");
    expect(doc.metadata).toEqual({
      kind: "agent",
      scope: "zone",
      lifecycle: "active",
      tags: ["auto"],
    });
  });

  test("handles empty tags", () => {
    const brick = createTestToolArtifact({
      id: brickId("tool-empty-tags"),
      name: "my-tool",
      description: "A useful tool",
      tags: [],
      inputSchema: {
        type: "object",
        properties: { input: { type: "string" }, format: { type: "string" } },
      },
    });
    const doc = mapBrickToIndexDoc(brick);

    expect(doc.content).toBe("my-tool A useful tool input format");
    expect(doc.metadata?.tags).toEqual([]);
  });

  test("handles tool brick with no properties in inputSchema", () => {
    const brick = createTestToolArtifact({
      id: brickId("tool-no-props"),
      name: "my-tool",
      description: "A useful tool",
      inputSchema: { type: "object" },
    });
    const doc = mapBrickToIndexDoc(brick);

    expect(doc.content).toContain("my-tool");
    expect(doc.content).toContain("A useful tool");
  });

  test("metadata shape matches expected structure", () => {
    const brick = createTestToolArtifact({
      id: brickId("tool-meta"),
      name: "my-tool",
      description: "A useful tool",
      tags: ["data", "transform"],
    });
    const doc = mapBrickToIndexDoc(brick);

    expect(doc.metadata).toBeDefined();
    expect(doc.metadata?.kind).toBe("tool");
    expect(doc.metadata?.scope).toBe("agent");
    expect(doc.metadata?.lifecycle).toBe("active");
    expect(doc.metadata?.tags).toEqual(["data", "transform"]);
  });

  test("skill brick with files but no SKILL.md", () => {
    const brick = createTestSkillArtifact({
      id: brickId("skill-no-skillmd"),
      name: "my-skill",
      files: { "README.md": "some readme" },
    });
    const doc = mapBrickToIndexDoc(brick);

    expect(doc.content).toContain("my-skill");
    expect(doc.content).not.toContain("some readme");
  });

  // --- trigger indexing ---

  test("includes trigger patterns in content", () => {
    const brick = createTestToolArtifact({
      id: brickId("tool-triggers"),
      name: "chart-tool",
      description: "Creates charts",
      trigger: ["visualize data", "create chart", "plot graph"],
      inputSchema: { type: "object" },
    });
    const doc = mapBrickToIndexDoc(brick);

    expect(doc.content).toContain("visualize data create chart plot graph");
  });

  test("omits trigger content when trigger is undefined", () => {
    const brick = createTestToolArtifact({
      id: brickId("tool-no-triggers"),
      name: "plain-tool",
      description: "No triggers",
      inputSchema: { type: "object" },
    });
    const doc = mapBrickToIndexDoc(brick);

    expect(doc.content).toBe("plain-tool No triggers");
  });

  test("omits trigger content when trigger is empty array", () => {
    const brick = createTestToolArtifact({
      id: brickId("tool-empty-triggers"),
      name: "plain-tool",
      description: "Empty triggers",
      trigger: [],
      inputSchema: { type: "object" },
    });
    const doc = mapBrickToIndexDoc(brick);

    expect(doc.content).toBe("plain-tool Empty triggers");
  });

  // --- evolution lineage ---

  test("includes parentBrickId in metadata when brick has evolution", () => {
    const brick = createTestToolArtifact({
      id: brickId("evolved-tool"),
      name: "evolved",
      description: "An evolved tool",
      provenance: {
        ...createTestToolArtifact().provenance,
        evolution: {
          parentBrickId: brickId("parent-id"),
          evolutionKind: "fix" as const,
        },
      },
    });
    const doc = mapBrickToIndexDoc(brick);

    expect(doc.metadata?.parentBrickId).toBe("parent-id");
    // parentBrickId should NOT be in content (hashes are noise for BM25/vector)
    expect(doc.content).not.toContain("parent-id");
  });

  test("omits parentBrickId from metadata when brick has no evolution", () => {
    const brick = createTestToolArtifact({
      id: brickId("root-tool"),
      name: "root",
      description: "A root tool",
    });
    const doc = mapBrickToIndexDoc(brick);

    expect(doc.metadata?.parentBrickId).toBeUndefined();
  });
});
