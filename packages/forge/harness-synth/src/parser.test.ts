import { describe, expect, test } from "bun:test";
import { parseSynthesisOutput } from "./parser.js";

const VALID_CODE = `export function createMiddleware() {
  return {
    name: "harness-search",
    priority: 180,
    phase: "intercept" as const,
    async wrapToolCall(ctx, req, next) {
      if (req.toolId !== "search") return next(req);
      if (!req.input.query || req.input.query.length === 0) {
        return { output: { error: true, message: "Query must not be empty" } };
      }
      return next(req);
    },
    describeCapabilities() { return undefined; },
  };
}`;

describe("parseSynthesisOutput", () => {
  test("parses valid code block with typescript fence", () => {
    const raw = `Here is the middleware:

\`\`\`typescript
${VALID_CODE}
\`\`\`

This validates the query parameter.`;

    const result = parseSynthesisOutput(raw, "search");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.code).toContain("createMiddleware");
      expect(result.value.code).toContain("wrapToolCall");
      expect(result.value.descriptor.name).toBe("harness-search");
      expect(result.value.descriptor.description).toContain("search");
    }
  });

  test("parses code block with ts fence", () => {
    const raw = `\`\`\`ts
${VALID_CODE}
\`\`\``;

    const result = parseSynthesisOutput(raw, "search");
    expect(result.ok).toBe(true);
  });

  test("parses code block with bare fence", () => {
    const raw = `\`\`\`
${VALID_CODE}
\`\`\``;

    const result = parseSynthesisOutput(raw, "search");
    expect(result.ok).toBe(true);
  });

  test("returns error for empty response", () => {
    const result = parseSynthesisOutput("", "search");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("Empty");
    }
  });

  test("returns error for response without code block", () => {
    const result = parseSynthesisOutput("Here is some text without any code.", "search");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("No code block");
    }
  });

  test("returns error when createMiddleware is missing", () => {
    const raw = `\`\`\`typescript
export function createValidator() {
  return { wrapToolCall() {} };
}
\`\`\``;

    const result = parseSynthesisOutput(raw, "search");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("createMiddleware");
    }
  });

  test("returns error when wrapToolCall is missing", () => {
    const raw = `\`\`\`typescript
export function createMiddleware() {
  return { name: "test" };
}
\`\`\``;

    const result = parseSynthesisOutput(raw, "search");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("wrapToolCall");
    }
  });

  test("uses fallback name when name not found in code", () => {
    const raw = `\`\`\`typescript
export function createMiddleware() {
  return {
    priority: 180,
    async wrapToolCall(ctx, req, next) { return next(req); },
  };
}
\`\`\``;

    const result = parseSynthesisOutput(raw, "my_tool");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.descriptor.name).toBe("harness-my_tool");
    }
  });

  test("rejects code using wrong API: req.toolName", () => {
    const raw = `\`\`\`typescript
export function createMiddleware() {
  return {
    async wrapToolCall(ctx, req, next) {
      if (req.toolName !== "x") return next(req);
      return next(req);
    },
  };
}
\`\`\``;
    const result = parseSynthesisOutput(raw, "x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("toolId");
  });

  test("rejects code using wrong API: req.args", () => {
    const raw = `\`\`\`typescript
export function createMiddleware() {
  return {
    async wrapToolCall(ctx, req, next) {
      if (!req.args.query) return { output: "err" };
      return next(req);
    },
  };
}
\`\`\``;
    const result = parseSynthesisOutput(raw, "x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("input");
  });

  test("rejects code using uppercase INTERCEPT phase", () => {
    const raw = `\`\`\`typescript
export function createMiddleware() {
  return {
    phase: "INTERCEPT",
    async wrapToolCall(ctx, req, next) { return next(req); },
  };
}
\`\`\``;
    const result = parseSynthesisOutput(raw, "x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("intercept");
  });

  test("extracts name from code when present", () => {
    const raw = `\`\`\`typescript
export function createMiddleware() {
  return {
    name: "custom-name",
    async wrapToolCall(ctx, req, next) { return next(req); },
  };
}
\`\`\``;

    const result = parseSynthesisOutput(raw, "search");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.descriptor.name).toBe("custom-name");
    }
  });
});
