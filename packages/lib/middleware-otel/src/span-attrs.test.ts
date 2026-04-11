/**
 * Unit tests for pure attribute builder functions.
 * No OTel SDK needed — just input/output assertions.
 */

import { describe, expect, test } from "bun:test";
import type { RichTrajectoryStep } from "@koi/core/rich-trajectory";
import {
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MAX_TOKENS,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_REQUEST_TEMPERATURE,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_KOI_SESSION_ID,
  ATTR_KOI_STEP_OUTCOME,
  GEN_AI_OPERATION_CHAT,
  GEN_AI_OPERATION_EXECUTE_TOOL,
} from "./semconv.js";
import {
  buildModelSpanAttrs,
  buildModelSpanName,
  buildToolSpanAttrs,
  buildToolSpanName,
  extractProviderName,
} from "./span-attrs.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeModelStep(overrides?: Partial<RichTrajectoryStep>): RichTrajectoryStep {
  return {
    stepIndex: 0,
    timestamp: 1_000,
    source: "agent",
    kind: "model_call",
    identifier: "gpt-4o",
    outcome: "success",
    durationMs: 500,
    metrics: { promptTokens: 100, completionTokens: 200 },
    metadata: {
      requestModel: "gpt-4o",
      temperature: 0.7,
      maxTokens: 1024,
      responseModel: "gpt-4o-2024-11-20",
      modelStopReason: "stop",
    },
    ...overrides,
  };
}

function makeToolStep(overrides?: Partial<RichTrajectoryStep>): RichTrajectoryStep {
  return {
    stepIndex: 1,
    timestamp: 2_000,
    source: "tool",
    kind: "tool_call",
    identifier: "bash",
    outcome: "success",
    durationMs: 100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractProviderName
// ---------------------------------------------------------------------------

describe("extractProviderName", () => {
  test("infers openai from gpt- prefix", () => {
    expect(extractProviderName("gpt-4o")).toBe("openai");
    expect(extractProviderName("gpt-3.5-turbo")).toBe("openai");
  });

  test("infers openai from o-series models", () => {
    expect(extractProviderName("o1-mini")).toBe("openai");
    expect(extractProviderName("o3-2025-01-31")).toBe("openai");
    expect(extractProviderName("o4-mini")).toBe("openai");
  });

  test("infers anthropic from claude- prefix", () => {
    expect(extractProviderName("claude-3-5-sonnet-20241022")).toBe("anthropic");
    expect(extractProviderName("claude-opus-4")).toBe("anthropic");
  });

  test("infers google from gemini- prefix", () => {
    expect(extractProviderName("gemini-2.0-flash")).toBe("google");
  });

  test("infers mistral for mistral/mixtral", () => {
    expect(extractProviderName("mistral-large")).toBe("mistral");
    expect(extractProviderName("mixtral-8x7b")).toBe("mistral");
  });

  test("returns unknown for unrecognized model ID", () => {
    expect(extractProviderName("some-custom-model")).toBe("unknown");
    expect(extractProviderName("")).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// buildModelSpanName / buildToolSpanName
// ---------------------------------------------------------------------------

describe("buildModelSpanName", () => {
  test("formats as 'chat {model}' per OTel spec", () => {
    const step = makeModelStep({ identifier: "gpt-4o" });
    expect(buildModelSpanName(step)).toBe("chat gpt-4o");
  });

  test("uses identifier even when unknown", () => {
    const step = makeModelStep({ identifier: "unknown" });
    expect(buildModelSpanName(step)).toBe("chat unknown");
  });
});

describe("buildToolSpanName", () => {
  test("formats as 'execute_tool {tool}' per OTel spec", () => {
    const step = makeToolStep({ identifier: "add_numbers" });
    expect(buildToolSpanName(step)).toBe("execute_tool add_numbers");
  });
});

// ---------------------------------------------------------------------------
// buildModelSpanAttrs
// ---------------------------------------------------------------------------

describe("buildModelSpanAttrs", () => {
  const SESSION_ID = "sess-abc123";

  test("includes required attributes", () => {
    const attrs = buildModelSpanAttrs(makeModelStep(), SESSION_ID);
    expect(attrs[ATTR_GEN_AI_OPERATION_NAME]).toBe(GEN_AI_OPERATION_CHAT);
    expect(attrs[ATTR_GEN_AI_PROVIDER_NAME]).toBe("openai");
    expect(attrs[ATTR_KOI_SESSION_ID]).toBe(SESSION_ID);
    expect(attrs[ATTR_KOI_STEP_OUTCOME]).toBe("success");
  });

  test("includes token usage from step metrics", () => {
    const attrs = buildModelSpanAttrs(makeModelStep(), SESSION_ID);
    expect(attrs[ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(100);
    expect(attrs[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(200);
  });

  test("includes request attributes from metadata", () => {
    const attrs = buildModelSpanAttrs(makeModelStep(), SESSION_ID);
    expect(attrs[ATTR_GEN_AI_REQUEST_MODEL]).toBe("gpt-4o");
    expect(attrs[ATTR_GEN_AI_REQUEST_TEMPERATURE]).toBe(0.7);
    expect(attrs[ATTR_GEN_AI_REQUEST_MAX_TOKENS]).toBe(1024);
  });

  test("includes response model from metadata (overrides identifier)", () => {
    const attrs = buildModelSpanAttrs(makeModelStep(), SESSION_ID);
    expect(attrs[ATTR_GEN_AI_RESPONSE_MODEL]).toBe("gpt-4o-2024-11-20");
  });

  test("includes finish reasons from metadata", () => {
    const attrs = buildModelSpanAttrs(makeModelStep(), SESSION_ID);
    expect(attrs[ATTR_GEN_AI_RESPONSE_FINISH_REASONS]).toEqual(["stop"]);
  });

  test("marks failure outcome", () => {
    const step = makeModelStep({ outcome: "failure" });
    const attrs = buildModelSpanAttrs(step, SESSION_ID);
    expect(attrs[ATTR_KOI_STEP_OUTCOME]).toBe("failure");
  });

  test("omits token usage when metrics absent", () => {
    const base = makeModelStep();
    const { metrics: _m, ...stepNoMetrics } = base;
    const attrs = buildModelSpanAttrs(stepNoMetrics as typeof base, SESSION_ID);
    expect(attrs[ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBeUndefined();
    expect(attrs[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBeUndefined();
  });

  test("omits request attrs when metadata absent", () => {
    const base = makeModelStep();
    const { metadata: _md, ...stepNoMeta } = base;
    const attrs = buildModelSpanAttrs(stepNoMeta as typeof base, SESSION_ID);
    expect(attrs[ATTR_GEN_AI_REQUEST_MODEL]).toBeUndefined();
    expect(attrs[ATTR_GEN_AI_REQUEST_TEMPERATURE]).toBeUndefined();
    expect(attrs[ATTR_GEN_AI_REQUEST_MAX_TOKENS]).toBeUndefined();
  });

  test("falls back to identifier for response model when no metadata", () => {
    const base = makeModelStep({ identifier: "claude-3-5-sonnet" });
    const { metadata: _md, ...stepNoMeta } = base;
    const attrs = buildModelSpanAttrs(stepNoMeta as typeof base, SESSION_ID);
    expect(attrs[ATTR_GEN_AI_RESPONSE_MODEL]).toBe("claude-3-5-sonnet");
    expect(attrs[ATTR_GEN_AI_PROVIDER_NAME]).toBe("anthropic");
  });
});

// ---------------------------------------------------------------------------
// buildToolSpanAttrs
// ---------------------------------------------------------------------------

describe("buildToolSpanAttrs", () => {
  const SESSION_ID = "sess-tool-test";

  test("includes required attributes", () => {
    const attrs = buildToolSpanAttrs(makeToolStep(), SESSION_ID);
    expect(attrs[ATTR_GEN_AI_OPERATION_NAME]).toBe(GEN_AI_OPERATION_EXECUTE_TOOL);
    expect(attrs[ATTR_GEN_AI_TOOL_NAME]).toBe("bash");
    expect(attrs[ATTR_KOI_SESSION_ID]).toBe(SESSION_ID);
    expect(attrs[ATTR_KOI_STEP_OUTCOME]).toBe("success");
  });

  test("includes tool call ID from metadata when present", () => {
    const step = makeToolStep({
      metadata: { decisionCorrelationId: "corr-xyz" },
    });
    const attrs = buildToolSpanAttrs(step, SESSION_ID);
    expect(attrs[ATTR_GEN_AI_TOOL_CALL_ID]).toBe("corr-xyz");
  });

  test("omits tool call ID when metadata absent", () => {
    const attrs = buildToolSpanAttrs(makeToolStep(), SESSION_ID);
    expect(attrs[ATTR_GEN_AI_TOOL_CALL_ID]).toBeUndefined();
  });

  test("marks failure outcome", () => {
    const step = makeToolStep({ outcome: "failure" });
    const attrs = buildToolSpanAttrs(step, SESSION_ID);
    expect(attrs[ATTR_KOI_STEP_OUTCOME]).toBe("failure");
  });
});
