import { describe, expect, test } from "bun:test";
import { validateBrickArtifact } from "./validate.js";

function validTool(): Record<string, unknown> {
  return {
    id: "brick_abc",
    kind: "tool",
    name: "test-tool",
    description: "A test tool",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    createdBy: "agent-1",
    createdAt: Date.now(),
    version: "0.0.1",
    tags: ["math"],
    usageCount: 0,
    contentHash: "abc123",
    implementation: "return 1;",
    inputSchema: { type: "object" },
  };
}

function validSkill(): Record<string, unknown> {
  return {
    ...validTool(),
    kind: "skill",
    content: "# Skill",
    implementation: undefined,
    inputSchema: undefined,
  };
}

function validAgent(): Record<string, unknown> {
  return {
    ...validTool(),
    kind: "agent",
    manifestYaml: "name: test",
    implementation: undefined,
    inputSchema: undefined,
  };
}

function validComposite(): Record<string, unknown> {
  return {
    ...validTool(),
    kind: "composite",
    brickIds: ["b1", "b2"],
    implementation: undefined,
    inputSchema: undefined,
  };
}

describe("validateBrickArtifact", () => {
  test("accepts valid tool artifact", () => {
    const result = validateBrickArtifact(validTool(), "test.json");
    expect(result.ok).toBe(true);
  });

  test("accepts valid skill artifact", () => {
    const result = validateBrickArtifact(validSkill(), "test.json");
    expect(result.ok).toBe(true);
  });

  test("accepts valid agent artifact", () => {
    const result = validateBrickArtifact(validAgent(), "test.json");
    expect(result.ok).toBe(true);
  });

  test("accepts valid composite artifact", () => {
    const result = validateBrickArtifact(validComposite(), "test.json");
    expect(result.ok).toBe(true);
  });

  test("rejects non-object", () => {
    const result = validateBrickArtifact("not an object", "test.json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.message).toContain("not an object");
    }
  });

  test("rejects null", () => {
    const result = validateBrickArtifact(null, "test.json");
    expect(result.ok).toBe(false);
  });

  test("rejects missing id", () => {
    const data = validTool();
    delete data.id;
    const result = validateBrickArtifact(data, "test.json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("id");
    }
  });

  test("rejects empty id", () => {
    const result = validateBrickArtifact({ ...validTool(), id: "" }, "test.json");
    expect(result.ok).toBe(false);
  });

  test("rejects unknown kind", () => {
    const result = validateBrickArtifact({ ...validTool(), kind: "unknown" }, "test.json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("kind");
    }
  });

  test("rejects invalid scope", () => {
    const result = validateBrickArtifact({ ...validTool(), scope: "invalid" }, "test.json");
    expect(result.ok).toBe(false);
  });

  test("rejects invalid trustTier", () => {
    const result = validateBrickArtifact({ ...validTool(), trustTier: "invalid" }, "test.json");
    expect(result.ok).toBe(false);
  });

  test("rejects invalid lifecycle", () => {
    const result = validateBrickArtifact({ ...validTool(), lifecycle: "invalid" }, "test.json");
    expect(result.ok).toBe(false);
  });

  test("rejects non-number createdAt", () => {
    const result = validateBrickArtifact(
      { ...validTool(), createdAt: "not a number" },
      "test.json",
    );
    expect(result.ok).toBe(false);
  });

  test("rejects non-array tags", () => {
    const result = validateBrickArtifact({ ...validTool(), tags: "not an array" }, "test.json");
    expect(result.ok).toBe(false);
  });

  test("rejects tool missing implementation", () => {
    const data = validTool();
    delete data.implementation;
    const result = validateBrickArtifact(data, "test.json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("implementation");
    }
  });

  test("rejects tool missing inputSchema", () => {
    const data = validTool();
    delete data.inputSchema;
    const result = validateBrickArtifact(data, "test.json");
    expect(result.ok).toBe(false);
  });

  test("rejects skill missing content", () => {
    const data = validSkill();
    delete data.content;
    const result = validateBrickArtifact(data, "test.json");
    expect(result.ok).toBe(false);
  });

  test("rejects agent missing manifestYaml", () => {
    const data = validAgent();
    delete data.manifestYaml;
    const result = validateBrickArtifact(data, "test.json");
    expect(result.ok).toBe(false);
  });

  test("rejects composite missing brickIds", () => {
    const data = validComposite();
    delete data.brickIds;
    const result = validateBrickArtifact(data, "test.json");
    expect(result.ok).toBe(false);
  });

  test("accepts artifact with valid files", () => {
    const result = validateBrickArtifact(
      { ...validTool(), files: { "lib/helper.ts": "export const x = 1;" } },
      "test.json",
    );
    expect(result.ok).toBe(true);
  });

  test("rejects artifact with non-object files", () => {
    const result = validateBrickArtifact({ ...validTool(), files: "bad" }, "test.json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("files");
    }
  });

  test("accepts artifact with valid requires", () => {
    const result = validateBrickArtifact(
      { ...validTool(), requires: { bins: ["node"], env: ["API_KEY"] } },
      "test.json",
    );
    expect(result.ok).toBe(true);
  });

  test("rejects artifact with non-object requires", () => {
    const result = validateBrickArtifact({ ...validTool(), requires: 42 }, "test.json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("requires");
    }
  });
});
