/**
 * Tests for extractBrickContent — maps brick kind to hashable primary content.
 */

import { describe, expect, test } from "bun:test";
import { extractBrickContent } from "./brick-content.js";

// ---------------------------------------------------------------------------
// extractBrickContent
// ---------------------------------------------------------------------------

describe("extractBrickContent", () => {
  test("tool -> implementation", () => {
    const result = extractBrickContent({
      kind: "tool",
      implementation: "return 42;",
    });
    expect(result.kind).toBe("tool");
    expect(result.content).toBe("return 42;");
  });

  test("skill -> content", () => {
    const result = extractBrickContent({
      kind: "skill",
      content: "# My Skill\nDo the thing.",
    });
    expect(result.kind).toBe("skill");
    expect(result.content).toBe("# My Skill\nDo the thing.");
  });

  test("agent -> manifestYaml", () => {
    const yaml = "name: my-agent\ntype: assistant";
    const result = extractBrickContent({
      kind: "agent",
      manifestYaml: yaml,
    });
    expect(result.kind).toBe("agent");
    expect(result.content).toBe(yaml);
  });

  test("composite -> step IDs joined", () => {
    const result = extractBrickContent({
      kind: "composite",
      steps: [{ brickId: "id-a" }, { brickId: "id-b" }, { brickId: "id-c" }],
    });
    expect(result.kind).toBe("composite");
    expect(result.content).toBe("id-a,id-b,id-c");
  });

  test("middleware -> implementation", () => {
    const result = extractBrickContent({
      kind: "middleware",
      implementation: "return middleware;",
    });
    expect(result.kind).toBe("middleware");
    expect(result.content).toBe("return middleware;");
  });

  test("channel -> implementation", () => {
    const result = extractBrickContent({
      kind: "channel",
      implementation: "return channel;",
    });
    expect(result.kind).toBe("channel");
    expect(result.content).toBe("return channel;");
  });

  test("tool with missing implementation returns empty string", () => {
    const result = extractBrickContent({ kind: "tool" });
    expect(result.content).toBe("");
  });

  test("skill with missing content returns empty string", () => {
    const result = extractBrickContent({ kind: "skill" });
    expect(result.content).toBe("");
  });

  test("agent with missing manifestYaml returns empty string", () => {
    const result = extractBrickContent({ kind: "agent" });
    expect(result.content).toBe("");
  });

  test("composite with missing steps returns empty string", () => {
    const result = extractBrickContent({ kind: "composite" });
    expect(result.content).toBe("");
  });
});
