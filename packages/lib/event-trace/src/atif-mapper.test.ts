import { describe, expect, test } from "bun:test";
import type { RichTrajectoryStep } from "@koi/core";
import {
  computeFinalMetrics,
  mapAtifDocumentToRich,
  mapAtifStepToRich,
  mapRichStepToAtif,
  mapRichToAtifDocument,
} from "./atif-mapper.js";

const MODEL_STEP: RichTrajectoryStep = {
  stepIndex: 0,
  timestamp: 1711929600000,
  source: "agent",
  kind: "model_call",
  identifier: "claude-3",
  outcome: "success",
  durationMs: 1200,
  request: { text: "What is 2+2?" },
  response: { text: "4" },
  metrics: { promptTokens: 10, completionTokens: 5, cachedTokens: 0, costUsd: 0.001 },
};

const TOOL_STEP: RichTrajectoryStep = {
  stepIndex: 1,
  timestamp: 1711929601000,
  source: "tool",
  kind: "tool_call",
  identifier: "read_file",
  outcome: "success",
  durationMs: 50,
  request: { text: "read foo.ts", data: { path: "foo.ts" } },
  response: { text: "file contents" },
  bulletIds: ["call-abc"],
};

describe("mapRichStepToAtif", () => {
  test("maps model_call step", () => {
    const atif = mapRichStepToAtif(MODEL_STEP);
    expect(atif.step_id).toBe(0);
    expect(atif.source).toBe("agent");
    expect(atif.model_name).toBe("claude-3");
    expect(atif.message).toBe("What is 2+2?");
    expect(atif.observation?.results?.[0]?.content).toBe("4");
    expect(atif.duration_ms).toBe(1200);
    expect(atif.outcome).toBe("success");
    expect(atif.metrics?.prompt_tokens).toBe(10);
    expect(atif.metrics?.completion_tokens).toBe(5);
  });

  test("maps tool_call step with bulletIds", () => {
    const atif = mapRichStepToAtif(TOOL_STEP);
    expect(atif.tool_calls).toHaveLength(1);
    expect(atif.tool_calls?.[0]?.function_name).toBe("read_file");
    expect(atif.tool_calls?.[0]?.tool_call_id).toBe("call-abc");
    expect(atif.tool_calls?.[0]?.arguments).toEqual({ path: "foo.ts" });
    expect(atif.model_name).toBeUndefined();
  });
});

describe("mapAtifStepToRich", () => {
  test("round-trip model_call preserves key fields", () => {
    const atif = mapRichStepToAtif(MODEL_STEP);
    const rich = mapAtifStepToRich(atif);
    expect(rich.kind).toBe("model_call");
    expect(rich.identifier).toBe("claude-3");
    expect(rich.outcome).toBe("success");
    expect(rich.durationMs).toBe(1200);
    expect(rich.request?.text).toBe("What is 2+2?");
    expect(rich.response?.text).toBe("4");
    expect(rich.metrics?.promptTokens).toBe(10);
  });

  test("round-trip tool_call preserves key fields", () => {
    const atif = mapRichStepToAtif(TOOL_STEP);
    const rich = mapAtifStepToRich(atif);
    expect(rich.kind).toBe("tool_call");
    expect(rich.identifier).toBe("read_file");
    expect(rich.outcome).toBe("success");
  });

  test("missing outcome defaults to success when response present", () => {
    const atif = mapRichStepToAtif(MODEL_STEP);
    // Remove outcome to test default inference
    const { outcome: _, ...rest } = atif;
    const rich = mapAtifStepToRich(rest as typeof atif);
    expect(rich.outcome).toBe("success");
  });

  test("missing outcome defaults to failure when no response", () => {
    const step: RichTrajectoryStep = {
      ...MODEL_STEP,
      outcome: "failure",
    };
    // Remove response so there's no observation
    const { response: _r, ...stepWithoutResponse } = step;
    const atif = mapRichStepToAtif(stepWithoutResponse as RichTrajectoryStep);
    const { outcome: _o, ...atifWithoutOutcome } = atif;
    const rich = mapAtifStepToRich(atifWithoutOutcome as typeof atif);
    expect(rich.outcome).toBe("failure");
  });
});

describe("mapRichToAtifDocument / mapAtifDocumentToRich", () => {
  test("round-trip document preserves steps", () => {
    const doc = mapRichToAtifDocument([MODEL_STEP, TOOL_STEP], {
      sessionId: "sess-1",
      agentName: "test-agent",
    });
    expect(doc.schema_version).toBe("ATIF-v1.6");
    expect(doc.session_id).toBe("sess-1");
    expect(doc.steps).toHaveLength(2);

    const richSteps = mapAtifDocumentToRich(doc);
    expect(richSteps).toHaveLength(2);
    expect(richSteps[0]?.kind).toBe("model_call");
    expect(richSteps[1]?.kind).toBe("tool_call");
  });
});

describe("computeFinalMetrics", () => {
  test("aggregates metrics across steps", () => {
    const metrics = computeFinalMetrics([MODEL_STEP, TOOL_STEP]);
    expect(metrics.total_prompt_tokens).toBe(10);
    expect(metrics.total_completion_tokens).toBe(5);
    expect(metrics.total_steps).toBe(2);
  });

  test("handles steps with no metrics", () => {
    const metrics = computeFinalMetrics([TOOL_STEP]);
    expect(metrics.total_prompt_tokens).toBe(0);
    expect(metrics.total_steps).toBe(1);
  });
});
