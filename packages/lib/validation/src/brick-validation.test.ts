import { describe, expect, test } from "bun:test";
import { DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import { validateBrickArtifact } from "./brick-validation.js";

function validTool(): Record<string, unknown> {
  return {
    id: "brick_abc",
    kind: "tool",
    name: "test-tool",
    description: "A test tool",
    scope: "agent",
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.0.1",
    tags: ["math"],
    usageCount: 0,
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
    implementation: undefined,
    inputSchema: undefined,
    steps: [
      {
        brickId: "sha256:aaa",
        inputPort: { name: "input", schema: { type: "object" } },
        outputPort: { name: "output", schema: { type: "object" } },
      },
    ],
    exposedInput: { name: "input", schema: { type: "object" } },
    exposedOutput: { name: "output", schema: { type: "object" } },
    outputKind: "tool",
  };
}

describe("validateBrickArtifact", () => {
  test("accepts valid tool artifact", () => {
    const result = validateBrickArtifact(validTool(), "test-source");
    expect(result.ok).toBe(true);
  });

  test("accepts valid skill artifact", () => {
    const result = validateBrickArtifact(validSkill(), "test-source");
    expect(result.ok).toBe(true);
  });

  test("accepts valid agent artifact", () => {
    const result = validateBrickArtifact(validAgent(), "test-source");
    expect(result.ok).toBe(true);
  });

  test("rejects non-object", () => {
    const result = validateBrickArtifact("not an object", "test-source");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL");
      expect(result.error.message).toContain("not an object");
    }
  });

  test("rejects null", () => {
    const result = validateBrickArtifact(null, "test-source");
    expect(result.ok).toBe(false);
  });

  test("rejects missing id", () => {
    const data = validTool();
    delete data.id;
    const result = validateBrickArtifact(data, "test-source");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("id");
    }
  });

  test("rejects empty id", () => {
    const result = validateBrickArtifact({ ...validTool(), id: "" }, "test-source");
    expect(result.ok).toBe(false);
  });

  test("rejects unknown kind", () => {
    const result = validateBrickArtifact({ ...validTool(), kind: "unknown" }, "test-source");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("kind");
    }
  });

  test("rejects invalid scope", () => {
    const result = validateBrickArtifact({ ...validTool(), scope: "invalid" }, "test-source");
    expect(result.ok).toBe(false);
  });

  test("rejects invalid policy", () => {
    const result = validateBrickArtifact({ ...validTool(), policy: "invalid" }, "test-source");
    expect(result.ok).toBe(false);
  });

  test("rejects invalid lifecycle", () => {
    const result = validateBrickArtifact({ ...validTool(), lifecycle: "invalid" }, "test-source");
    expect(result.ok).toBe(false);
  });

  test("rejects non-object provenance", () => {
    const result = validateBrickArtifact(
      { ...validTool(), provenance: "not an object" },
      "test-source",
    );
    expect(result.ok).toBe(false);
  });

  test("rejects non-array tags", () => {
    const result = validateBrickArtifact({ ...validTool(), tags: "not an array" }, "test-source");
    expect(result.ok).toBe(false);
  });

  test("rejects tool missing implementation", () => {
    const data = validTool();
    delete data.implementation;
    const result = validateBrickArtifact(data, "test-source");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("implementation");
    }
  });

  test("rejects tool missing inputSchema", () => {
    const data = validTool();
    delete data.inputSchema;
    const result = validateBrickArtifact(data, "test-source");
    expect(result.ok).toBe(false);
  });

  test("rejects skill missing content", () => {
    const data = validSkill();
    delete data.content;
    const result = validateBrickArtifact(data, "test-source");
    expect(result.ok).toBe(false);
  });

  test("rejects agent missing manifestYaml", () => {
    const data = validAgent();
    delete data.manifestYaml;
    const result = validateBrickArtifact(data, "test-source");
    expect(result.ok).toBe(false);
  });

  test("accepts tool with outputSchema", () => {
    const result = validateBrickArtifact(
      {
        ...validTool(),
        outputSchema: { type: "object", properties: { result: { type: "string" } } },
      },
      "test-source",
    );
    expect(result.ok).toBe(true);
  });

  test("rejects tool with non-object outputSchema", () => {
    const result = validateBrickArtifact(
      { ...validTool(), outputSchema: "not-an-object" },
      "test-source",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("outputSchema");
    }
  });

  test("accepts artifact with valid files", () => {
    const result = validateBrickArtifact(
      { ...validTool(), files: { "lib/helper.ts": "export const x = 1;" } },
      "test-source",
    );
    expect(result.ok).toBe(true);
  });

  test("rejects artifact with non-object files", () => {
    const result = validateBrickArtifact({ ...validTool(), files: "bad" }, "test-source");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("files");
    }
  });

  test("accepts artifact with valid requires", () => {
    const result = validateBrickArtifact(
      { ...validTool(), requires: { bins: ["node"], env: ["API_KEY"] } },
      "test-source",
    );
    expect(result.ok).toBe(true);
  });

  test("rejects artifact with non-object requires", () => {
    const result = validateBrickArtifact({ ...validTool(), requires: 42 }, "test-source");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("requires");
    }
  });

  test("accepts valid composite artifact", () => {
    const result = validateBrickArtifact(validComposite(), "test-source");
    expect(result.ok).toBe(true);
  });

  test("rejects composite missing steps", () => {
    const data = validComposite();
    delete data.steps;
    const result = validateBrickArtifact(data, "test-source");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("steps");
    }
  });

  test("rejects composite missing exposedInput", () => {
    const data = validComposite();
    delete data.exposedInput;
    const result = validateBrickArtifact(data, "test-source");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("exposedInput");
    }
  });

  test("rejects composite missing exposedOutput", () => {
    const data = validComposite();
    delete data.exposedOutput;
    const result = validateBrickArtifact(data, "test-source");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("exposedOutput");
    }
  });

  test("rejects composite missing outputKind", () => {
    const data = validComposite();
    delete data.outputKind;
    const result = validateBrickArtifact(data, "test-source");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("outputKind");
    }
  });
});
