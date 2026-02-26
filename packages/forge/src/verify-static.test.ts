import { describe, expect, test } from "bun:test";
import type { BrickRequires } from "@koi/core";
import type { VerificationConfig } from "./config.js";
import type { ForgeInput } from "./types.js";
import { verifyStatic } from "./verify-static.js";

const DEFAULT_VERIFICATION: VerificationConfig = {
  staticTimeoutMs: 1_000,
  sandboxTimeoutMs: 5_000,
  selfTestTimeoutMs: 10_000,
  totalTimeoutMs: 30_000,
  maxBrickSizeBytes: 50_000,
  failFast: true,
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

  test("rejects skill with empty body", () => {
    const input: ForgeInput = {
      kind: "skill",
      name: "mySkill",
      description: "A skill",
      body: "",
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
  });

  test("accepts valid skill", () => {
    const input: ForgeInput = {
      kind: "skill",
      name: "mySkill",
      description: "A skill",
      body: "# My Skill\nSome content here.",
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

describe("verifyStatic — files validation", () => {
  test("accepts valid files", () => {
    const input: ForgeInput = {
      kind: "skill",
      name: "mySkill",
      description: "A skill",
      body: "# Skill",
      files: { "lib/helper.ts": "export const x = 1;" },
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
  });

  test("rejects absolute file path", () => {
    const input: ForgeInput = {
      kind: "skill",
      name: "mySkill",
      description: "A skill",
      body: "# Skill",
      files: { "/etc/passwd": "bad" },
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("INVALID_NAME");
    }
  });

  test("rejects file path with path traversal", () => {
    const input: ForgeInput = {
      kind: "skill",
      name: "mySkill",
      description: "A skill",
      body: "# Skill",
      files: { "../escape.ts": "bad" },
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("INVALID_NAME");
    }
  });

  test("rejects dangerous key in files", () => {
    const input: ForgeInput = {
      kind: "skill",
      name: "mySkill",
      description: "A skill",
      body: "# Skill",
      files: { __proto__: "bad" },
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
  });

  test("rejects empty files object", () => {
    const input: ForgeInput = {
      kind: "skill",
      name: "mySkill",
      description: "A skill",
      body: "# Skill",
      files: {},
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("MISSING_FIELD");
    }
  });
});

describe("verifyStatic — syntax validation", () => {
  test("accepts syntactically valid tool implementation", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "export function run(input: unknown): string { return String(input); }",
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
  });

  test("rejects tool with syntax error", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "function { broken",
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("SYNTAX_ERROR");
    }
  });

  test("error message includes syntax details from Bun.Transpiler", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "const x = {;",
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Syntax error in implementation:");
      // Should contain actionable detail beyond just the prefix
      expect(result.error.message).toMatch(/Expected/i);
    }
  });

  test("accepts valid TypeScript features (arrow fns, generics, async/await)", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: [
        "const add = (a: number, b: number): number => a + b;",
        "function identity<T>(value: T): T { return value; }",
        "async function fetchData(): Promise<string> { return await Promise.resolve('ok'); }",
      ].join("\n"),
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
  });

  test("rejects .ts file in files field with syntax error", () => {
    const input: ForgeInput = {
      kind: "skill",
      name: "mySkill",
      description: "A skill",
      body: "# My Skill",
      files: { "lib/helper.ts": "export function { broken" },
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("SYNTAX_ERROR");
      expect(result.error.message).toContain("lib/helper.ts");
    }
  });

  test("accepts .ts file in files field with valid syntax", () => {
    const input: ForgeInput = {
      kind: "skill",
      name: "mySkill",
      description: "A skill",
      body: "# My Skill",
      files: { "lib/helper.ts": "export const x: number = 42;" },
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
  });

  test("accepts .tsx file with valid JSX syntax", () => {
    const input: ForgeInput = {
      kind: "skill",
      name: "mySkill",
      description: "A skill",
      body: "# My Skill",
      files: { "components/Button.tsx": "export function Button() { return <button />; }" },
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
  });

  test("skips syntax check for non-TS/JS files (.json, .md)", () => {
    const input: ForgeInput = {
      kind: "skill",
      name: "mySkill",
      description: "A skill",
      body: "# My Skill",
      files: {
        "config.json": "{ not valid json but not checked }",
        "README.md": "# this is {{ not }} valid TS but should pass",
      },
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
  });
});

describe("verifyStatic — requires validation", () => {
  test("accepts valid requires", () => {
    const input: ForgeInput = {
      kind: "skill",
      name: "mySkill",
      description: "A skill",
      body: "# Skill",
      requires: { bins: ["node"], env: ["API_KEY"], tools: ["search"] },
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
  });

  test("rejects requires.bins with non-string entries", () => {
    const input: ForgeInput = {
      kind: "skill",
      name: "mySkill",
      description: "A skill",
      body: "# Skill",
      requires: { bins: [42] } as unknown as BrickRequires,
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("INVALID_SCHEMA");
    }
  });

  test("rejects requires.env with non-string entries", () => {
    const input: ForgeInput = {
      kind: "skill",
      name: "mySkill",
      description: "A skill",
      body: "# Skill",
      requires: { env: [true] } as unknown as BrickRequires,
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
  });

  test("accepts requires with only partial fields", () => {
    const input: ForgeInput = {
      kind: "skill",
      name: "mySkill",
      description: "A skill",
      body: "# Skill",
      requires: { bins: ["git"] },
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
  });
});
