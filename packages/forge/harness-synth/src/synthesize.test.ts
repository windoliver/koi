import { describe, expect, test } from "bun:test";
import { synthesize } from "./synthesize.js";
import type { QualifiedFailures, SynthesisInput, ToolFailureRecord } from "./types.js";

const VALID_LLM_RESPONSE = `Here is the middleware:

\`\`\`typescript
export function createMiddleware() {
  return {
    name: "harness-search",
    priority: 180,
    phase: "intercept" as const,
    async wrapToolCall(ctx, req, next) {
      if (req.toolId !== "search") return next(req);
      if (!req.input?.query) {
        return { output: { error: true, message: "Query parameter is required" } };
      }
      return next(req);
    },
    describeCapabilities() { return undefined; },
  };
}
\`\`\``;

function makeFailures(): QualifiedFailures {
  const failures: readonly ToolFailureRecord[] = [
    {
      timestamp: Date.now() - 60_000,
      toolName: "search",
      errorCode: "VALIDATION",
      errorMessage: "Missing query parameter",
      parameters: {},
    },
    {
      timestamp: Date.now() - 120_000,
      toolName: "search",
      errorCode: "TIMEOUT",
      errorMessage: "Exceeded 30s limit",
      parameters: { query: "" },
    },
    {
      timestamp: Date.now() - 180_000,
      toolName: "search",
      errorCode: "RATE_LIMIT",
      errorMessage: "Too many requests",
      parameters: { query: "test" },
    },
  ];
  return {
    failures,
    rawCount: 5,
    deduplicatedCount: 2,
    staleCount: 0,
    clusterCount: 3,
  };
}

function makeInput(): SynthesisInput {
  return {
    failures: makeFailures(),
    targetToolName: "search",
    targetToolSchema: { type: "object", properties: { query: { type: "string" } } },
  };
}

describe("synthesize", () => {
  test("returns synthesized code on successful LLM call", async () => {
    const generate = async (_prompt: string): Promise<string> => VALID_LLM_RESPONSE;
    const result = await synthesize(makeInput(), generate);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.code).toContain("createMiddleware");
      expect(result.value.code).toContain("wrapToolCall");
      expect(result.value.descriptor.name).toBe("harness-search");
      expect(result.value.iterationCount).toBe(1);
    }
  });

  test("returns error when LLM callback throws", async () => {
    const generate = async (_prompt: string): Promise<string> => {
      throw new Error("Rate limited");
    };
    const result = await synthesize(makeInput(), generate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("LLM generation failed");
      expect(result.reason).toContain("Rate limited");
    }
  });

  test("returns error when LLM returns invalid output", async () => {
    const generate = async (_prompt: string): Promise<string> => "No code here, just text.";
    const result = await synthesize(makeInput(), generate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("No code block");
    }
  });

  test("returns error when LLM returns empty string", async () => {
    const generate = async (_prompt: string): Promise<string> => "";
    const result = await synthesize(makeInput(), generate);

    expect(result.ok).toBe(false);
  });

  test("passes target tool name and schema to prompt", async () => {
    let capturedPrompt = "";
    const generate = async (prompt: string): Promise<string> => {
      capturedPrompt = prompt;
      return VALID_LLM_RESPONSE;
    };
    await synthesize(makeInput(), generate);

    expect(capturedPrompt).toContain("search");
    expect(capturedPrompt).toContain("VALIDATION");
    expect(capturedPrompt).toContain("TIMEOUT");
    expect(capturedPrompt).toContain("RATE_LIMIT");
    expect(capturedPrompt).toContain('"query"');
  });

  test("handles non-Error thrown from generate callback", async () => {
    const generate = async (_prompt: string): Promise<string> => {
      throw "string error"; // eslint-disable-line no-throw-literal
    };
    const result = await synthesize(makeInput(), generate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("string error");
    }
  });
});
