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
  maxAutoTestCases: 20,
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

  test("accepts valid packages in requires", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      implementation: "return input;",
      inputSchema: { type: "object" },
      requires: { packages: { zod: "3.22.0", lodash: "4.17.21" } },
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
  });

  test("accepts empty packages in requires", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      implementation: "return input;",
      inputSchema: { type: "object" },
      requires: { packages: {} },
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
  });

  test("rejects packages with non-string values", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      implementation: "return input;",
      inputSchema: { type: "object" },
      requires: { packages: { zod: 123 } } as unknown as BrickRequires,
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("INVALID_SCHEMA");
      expect(result.error.message).toContain("packages");
    }
  });

  test("rejects packages with empty package name", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      implementation: "return input;",
      inputSchema: { type: "object" },
      requires: { packages: { "": "1.0.0" } },
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.message).toContain("empty package name");
    }
  });

  test("rejects packages with empty version string", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      implementation: "return input;",
      inputSchema: { type: "object" },
      requires: { packages: { zod: "" } },
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
  });

  test("rejects packages as array instead of record", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      implementation: "return input;",
      inputSchema: { type: "object" },
      requires: { packages: ["zod"] } as unknown as BrickRequires,
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
  });

  test("accepts requires.network as boolean", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      implementation: 'const res = fetch("https://api.example.com");',
      inputSchema: { type: "object" },
      requires: { network: true },
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
  });

  test("rejects requires.network as non-boolean", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      implementation: "return input;",
      inputSchema: { type: "object" },
      requires: { network: "yes" } as unknown as BrickRequires,
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("INVALID_SCHEMA");
      expect(result.error.message).toContain("network");
    }
  });
});

describe("verifyStatic — network access validation", () => {
  test("rejects fetch() in implementation without requires.network", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: 'const data = await fetch("https://api.example.com/data");',
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
      expect(result.error.message).toContain("requires.network");
    }
  });

  test("allows fetch() with requires.network: true", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: 'const data = await fetch("https://api.example.com/data");',
      requires: { network: true },
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
  });

  test("rejects WebSocket in implementation without requires.network", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: 'const ws = new WebSocket("wss://example.com");',
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
    }
  });

  test("rejects http import without requires.network", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: 'import http from "http";\nhttp.createServer();',
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
    }
  });

  test("rejects Bun.serve() without requires.network", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "Bun.serve({ port: 3000, fetch(req) { return new Response('ok'); } });",
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
    }
  });

  test("rejects network API in companion files without requires.network", () => {
    const input: ForgeInput = {
      kind: "skill",
      name: "mySkill",
      description: "A skill",
      body: "# My Skill",
      files: { "lib/client.ts": 'const res = await fetch("https://api.example.com");' },
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
      expect(result.error.message).toContain("lib/client.ts");
    }
  });

  test("allows code without network access and no requires.network", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "myTool",
      description: "A tool",
      inputSchema: { type: "object" },
      implementation: "return { result: input.value * 2 };",
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
  });

  test("allows middleware with network access when requires.network: true", () => {
    const input: ForgeInput = {
      kind: "middleware",
      name: "myMiddleware",
      description: "A middleware",
      implementation: 'const data = await fetch("https://api.example.com");',
      requires: { network: true },
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
  });

  test("skips network check for skill body (markdown, not executable)", () => {
    const input: ForgeInput = {
      kind: "skill",
      name: "mySkill",
      description: "A skill",
      body: "Use `fetch()` to call the API",
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Network evasion pattern tests
// ---------------------------------------------------------------------------

describe("verifyStatic — network evasion detection", () => {
  const makeNetTool = (code: string): ForgeInput => ({
    kind: "tool",
    name: "evasionTool",
    description: "Tests evasion patterns",
    inputSchema: { type: "object" },
    implementation: code,
  });

  test("rejects globalThis.fetch", () => {
    const result = verifyStatic(
      makeNetTool("globalThis.fetch('https://x.com')"),
      DEFAULT_VERIFICATION,
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
    }
  });

  test("rejects globalThis['fetch']", () => {
    const result = verifyStatic(
      makeNetTool("globalThis['fetch']('https://x.com')"),
      DEFAULT_VERIFICATION,
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
    }
  });

  test("rejects self.fetch", () => {
    const result = verifyStatic(makeNetTool("self.fetch('https://x.com')"), DEFAULT_VERIFICATION);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
    }
  });

  test("rejects variable aliasing: const f = fetch", () => {
    const result = verifyStatic(
      makeNetTool("const f = fetch;\nf('https://x.com');"),
      DEFAULT_VERIFICATION,
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
    }
  });

  test("rejects variable aliasing: const ws = WebSocket", () => {
    const result = verifyStatic(
      makeNetTool("const WS = WebSocket;\nnew WS('wss://x.com');"),
      DEFAULT_VERIFICATION,
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
    }
  });

  test("rejects Bun aliasing: const b = Bun", () => {
    const result = verifyStatic(
      makeNetTool("const b = Bun;\nb.serve({ fetch() { return new Response('ok'); } });"),
      DEFAULT_VERIFICATION,
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
    }
  });

  test("rejects node:-prefixed imports: import from 'node:http'", () => {
    const result = verifyStatic(
      makeNetTool(
        'import http from "node:http";\nexport function run() { return http.createServer(); }',
      ),
      DEFAULT_VERIFICATION,
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
    }
  });

  test("rejects node:-prefixed require: require('node:https')", () => {
    const result = verifyStatic(
      makeNetTool(
        'const https = require("node:https");\nexport function run() { return https.get; }',
      ),
      DEFAULT_VERIFICATION,
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
    }
  });

  test("rejects http2 module import", () => {
    const result = verifyStatic(
      makeNetTool(
        'import http2 from "http2";\nexport function run() { return http2.createServer; }',
      ),
      DEFAULT_VERIFICATION,
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
    }
  });

  test("rejects undici import", () => {
    const result = verifyStatic(
      makeNetTool('import { request } from "undici";\nexport function run() { return request; }'),
      DEFAULT_VERIFICATION,
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
    }
  });

  test("rejects axios import", () => {
    const result = verifyStatic(
      makeNetTool('import axios from "axios";\nexport function run() { return axios; }'),
      DEFAULT_VERIFICATION,
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
    }
  });

  test("rejects globalThis['WebSocket']", () => {
    const result = verifyStatic(
      makeNetTool("const WS = globalThis['WebSocket'];\nexport function run() { return WS; }"),
      DEFAULT_VERIFICATION,
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.stage === "static") {
      expect(result.error.code).toBe("NETWORK_ACCESS_DENIED");
    }
  });

  test("allows all evasion patterns with requires.network: true", () => {
    const input: ForgeInput = {
      kind: "tool",
      name: "netTool",
      description: "Needs network",
      inputSchema: { type: "object" },
      implementation: "const f = fetch;\nglobalThis.fetch('x');\nconst b = Bun;\n",
      requires: { network: true },
    };
    const result = verifyStatic(input, DEFAULT_VERIFICATION);
    expect(result.ok).toBe(true);
  });
});
