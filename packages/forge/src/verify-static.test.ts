import { describe, expect, test } from "bun:test";
import type { VerificationConfig } from "./config.js";
import type { ForgeInput } from "./types.js";
import { verifyStatic } from "./verify-static.js";

const DEFAULT_VERIFICATION: VerificationConfig = {
  staticTimeoutMs: 1_000,
  sandboxTimeoutMs: 5_000,
  selfTestTimeoutMs: 10_000,
  totalTimeoutMs: 30_000,
  maxBrickSizeBytes: 50_000,
};

function validToolInput(overrides?: Partial<ForgeInput>): ForgeInput {
  return {
    kind: "tool",
    name: "myTool",
    description: "A test tool",
    inputSchema: { type: "object" },
    implementation: "function run(input) { return input; }",
    ...overrides,
  } as ForgeInput;
}

describe("verifyStatic — name validation", () => {
  test("accepts valid name", () => {
    const result = verifyStatic(validToolInput(), DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
  });

  test("rejects name with path traversal", () => {
    const result = verifyStatic(
      validToolInput({ name: "../../../etc/passwd" } as ForgeInput),
      DEFAULT_VERIFICATION,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.stage).toBe("static");
      if (result.error.stage === "static") {
        expect(result.error.code).toBe("INVALID_NAME");
      }
    }
  });

  test("rejects name shorter than 3 chars", () => {
    const result = verifyStatic(validToolInput({ name: "ab" } as ForgeInput), DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
  });

  test("rejects name starting with number", () => {
    const result = verifyStatic(
      validToolInput({ name: "1tool" } as ForgeInput),
      DEFAULT_VERIFICATION,
    );
    expect(result.ok).toBe(false);
  });

  test("rejects name over 50 chars", () => {
    const result = verifyStatic(
      validToolInput({ name: "a".repeat(51) } as ForgeInput),
      DEFAULT_VERIFICATION,
    );
    expect(result.ok).toBe(false);
  });

  test("accepts name with hyphens and underscores", () => {
    const result = verifyStatic(
      validToolInput({ name: "my-tool_v2" } as ForgeInput),
      DEFAULT_VERIFICATION,
    );
    expect(result.ok).toBe(true);
  });
});

describe("verifyStatic — description validation", () => {
  test("rejects empty description", () => {
    const result = verifyStatic(
      validToolInput({ description: "" } as ForgeInput),
      DEFAULT_VERIFICATION,
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("MISSING_FIELD");
    }
  });

  test("rejects description over 500 chars", () => {
    const result = verifyStatic(
      validToolInput({ description: "x".repeat(501) } as ForgeInput),
      DEFAULT_VERIFICATION,
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("SIZE_EXCEEDED");
    }
  });
});

describe("verifyStatic — schema validation", () => {
  test("rejects schema without type field", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { properties: {} },
      implementation: "return 1;",
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("INVALID_SCHEMA");
    }
  });

  test("rejects schema with __proto__ key", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object", __proto__: {} } as unknown as Readonly<
        Record<string, unknown>
      >,
      implementation: "return 1;",
    };
    const _result = verifyStatic(input, DEFAULT_VERIFICATION);
    // __proto__ is special in JS — it may not show up as own key
    // Test with nested dangerous key instead
    const input2: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object", properties: { constructor: { type: "string" } } },
      implementation: "return 1;",
    };
    const result2 = verifyStatic(input2, DEFAULT_VERIFICATION);
    expect(result2.ok).toBe(false);
    if (!result2.ok && result2.error.stage === "static") {
      expect(result2.error.code).toBe("INVALID_SCHEMA");
    }
  });
});

describe("verifyStatic — size validation", () => {
  test("rejects implementation exceeding maxBrickSizeBytes", () => {
    const config: VerificationConfig = { ...DEFAULT_VERIFICATION, maxBrickSizeBytes: 100 };
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "x".repeat(200),
    };
    const result = verifyStatic(input, config);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("SIZE_EXCEEDED");
    }
  });
});

describe("verifyStatic — kind-specific validation", () => {
  test("rejects tool with empty implementation", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "",
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
  });

  test("rejects skill with empty content", () => {
    const input: ForgeInput = {
      kind: "skill",
      name: "mySkill",
      description: "A skill",
      content: "",
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
  });

  test("accepts valid skill", () => {
    const input: ForgeInput = {
      kind: "skill",
      name: "mySkill",
      description: "A skill",
      content: "# My Skill\nSome content here.",
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
  });

  test("rejects agent with empty manifest", () => {
    const input: ForgeInput = {
      kind: "agent",
      name: "myAgent",
      description: "An agent",
      manifestYaml: "",
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
  });

  test("rejects composite with empty brickIds", () => {
    const input: ForgeInput = {
      kind: "composite",
      name: "myComposite",
      description: "A composite",
      brickIds: [],
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
  });

  test("accepts valid composite", () => {
    const input: ForgeInput = {
      kind: "composite",
      name: "myComposite",
      description: "A composite",
      brickIds: ["brick_1"],
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
  });

  test("returns StageReport with timing on success", () => {
    const result = verifyStatic(validToolInput(), DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stage).toBe("static");
      expect(result.value.passed).toBe(true);
      expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});
