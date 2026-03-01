import { describe, expect, test } from "bun:test";
import type { MiddlewareBundle } from "@koi/core";
import type { ModelResponse } from "@koi/core/middleware";
import { createMockTurnContext } from "@koi/test-utils";
import { createCompactorBundle } from "./compactor-bundle.js";

function createMockSummarizer(summary = "Test summary") {
  return async (): Promise<ModelResponse> => ({
    content: summary,
    model: "test-model",
  });
}

describe("createCompactorBundle", () => {
  test("returns middleware with name 'koi:compactor'", () => {
    const bundle = createCompactorBundle({
      summarizer: createMockSummarizer(),
    });
    expect(bundle.middleware.name).toBe("koi:compactor");
  });

  test("returns exactly 1 provider", () => {
    const bundle = createCompactorBundle({
      summarizer: createMockSummarizer(),
    });
    expect(bundle.providers).toHaveLength(1);
  });

  test("middleware.scheduleCompaction is a function", () => {
    const bundle = createCompactorBundle({
      summarizer: createMockSummarizer(),
    });
    expect(typeof bundle.middleware.scheduleCompaction).toBe("function");
  });

  test("middleware.formatOccupancy is a function", () => {
    const bundle = createCompactorBundle({
      summarizer: createMockSummarizer(),
    });
    expect(typeof bundle.middleware.formatOccupancy).toBe("function");
  });

  test("describeCapabilities mentions compact_context", () => {
    const bundle = createCompactorBundle({
      summarizer: createMockSummarizer(),
    });
    const ctx = createMockTurnContext();
    const result = bundle.middleware.describeCapabilities(ctx);
    expect(result?.description).toContain("compact_context");
  });

  test("structurally satisfies MiddlewareBundle", () => {
    const bundle = createCompactorBundle({
      summarizer: createMockSummarizer(),
    });
    // Structural check — assign to MiddlewareBundle-typed variable
    const asBundle: MiddlewareBundle = bundle;
    expect(asBundle.middleware).toBeDefined();
    expect(asBundle.providers).toBeDefined();
  });
});
