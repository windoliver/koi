import { describe, expect, test } from "bun:test";
import type { RichTrajectoryStep } from "@koi/core/rich-trajectory";
import {
  computeFinalMetrics,
  flattenStep,
  mapAtifToRichTrajectory,
  mapRichTrajectoryToAtif,
  parseStep,
} from "./atif-mappers.js";
import type { AtifAgentStep, AtifDocument, AtifToolStep } from "./atif-types.js";
import { ATIF_SCHEMA_VERSION } from "./atif-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgentStep(overrides: Partial<RichTrajectoryStep> = {}): RichTrajectoryStep {
  return {
    stepIndex: 0,
    timestamp: 1700000000000,
    source: "agent",
    kind: "model_call",
    identifier: "claude-sonnet-4-20250514",
    outcome: "success",
    durationMs: 1500,
    request: { text: "Hello" },
    response: { text: "Hi there!" },
    metrics: { promptTokens: 100, completionTokens: 50 },
    ...overrides,
  };
}

function makeToolStep(overrides: Partial<RichTrajectoryStep> = {}): RichTrajectoryStep {
  return {
    stepIndex: 1,
    timestamp: 1700000001000,
    source: "tool",
    kind: "tool_call",
    identifier: "web_search",
    outcome: "success",
    durationMs: 500,
    request: { data: { query: "test" } },
    response: { text: "Search results here" },
    ...overrides,
  };
}

function makeUserStep(overrides: Partial<RichTrajectoryStep> = {}): RichTrajectoryStep {
  return {
    stepIndex: 2,
    timestamp: 1700000002000,
    source: "user",
    kind: "model_call",
    identifier: "user",
    outcome: "success",
    durationMs: 0,
    request: { text: "What is the weather?" },
    ...overrides,
  };
}

function makeSystemStep(overrides: Partial<RichTrajectoryStep> = {}): RichTrajectoryStep {
  return {
    stepIndex: 3,
    timestamp: 1700000003000,
    source: "system",
    kind: "model_call",
    identifier: "system",
    outcome: "success",
    durationMs: 0,
    request: { text: "You are a helpful assistant." },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Forward mapping: Rich → ATIF
// ---------------------------------------------------------------------------

describe("mapRichTrajectoryToAtif", () => {
  test("creates valid ATIF document", () => {
    const steps = [makeAgentStep()];
    const doc = mapRichTrajectoryToAtif(steps, {
      sessionId: "session-1",
      agentName: "test-agent",
      agentVersion: "1.0.0",
    });

    expect(doc.schema_version).toBe(ATIF_SCHEMA_VERSION);
    expect(doc.session_id).toBe("session-1");
    expect(doc.agent.name).toBe("test-agent");
    expect(doc.agent.version).toBe("1.0.0");
    expect(doc.steps).toHaveLength(1);
  });

  test("omits optional agent version when undefined", () => {
    const doc = mapRichTrajectoryToAtif([], {
      sessionId: "s1",
      agentName: "agent",
    });
    expect(doc.agent.version).toBeUndefined();
    expect("version" in doc.agent).toBe(false);
  });

  test("includes notes when provided", () => {
    const doc = mapRichTrajectoryToAtif([], {
      sessionId: "s1",
      agentName: "agent",
      notes: "Test run",
    });
    expect(doc.notes).toBe("Test run");
  });

  test("maps agent step with model_call kind", () => {
    const step = makeAgentStep();
    const doc = mapRichTrajectoryToAtif([step], {
      sessionId: "s1",
      agentName: "agent",
    });

    const atifStep = doc.steps[0] as AtifAgentStep;
    expect(atifStep?.source).toBe("agent");
    expect(atifStep?.message).toBe("Hello");
    expect(atifStep?.model_name).toBe("claude-sonnet-4-20250514");
    expect(atifStep?.observation?.results?.[0]?.content).toBe("Hi there!");
    expect(atifStep?.duration_ms).toBe(1500);
    expect(atifStep?.outcome).toBe("success");
  });

  test("maps tool step", () => {
    const step = makeToolStep();
    const doc = mapRichTrajectoryToAtif([step], {
      sessionId: "s1",
      agentName: "agent",
    });

    const atifStep = doc.steps[0] as AtifToolStep;
    expect(atifStep?.source).toBe("tool");
    expect(atifStep?.tool_calls).toHaveLength(1);
    expect(atifStep?.tool_calls[0]?.function_name).toBe("web_search");
    expect(atifStep?.observation?.results?.[0]?.content).toBe("Search results here");
  });

  test("maps user step", () => {
    const step = makeUserStep();
    const doc = mapRichTrajectoryToAtif([step], {
      sessionId: "s1",
      agentName: "agent",
    });

    const atifStep = doc.steps[0];
    expect(atifStep?.source).toBe("user");
    if (atifStep?.source === "user") {
      expect(atifStep.message).toBe("What is the weather?");
    }
  });

  test("maps system step", () => {
    const step = makeSystemStep();
    const doc = mapRichTrajectoryToAtif([step], {
      sessionId: "s1",
      agentName: "agent",
    });

    const atifStep = doc.steps[0];
    expect(atifStep?.source).toBe("system");
    if (atifStep?.source === "system") {
      expect(atifStep.message).toBe("You are a helpful assistant.");
    }
  });

  test("maps step metrics to ATIF format", () => {
    const step = makeAgentStep({
      metrics: { promptTokens: 100, completionTokens: 50, cachedTokens: 20, costUsd: 0.005 },
    });
    const doc = mapRichTrajectoryToAtif([step], { sessionId: "s1", agentName: "a" });
    const metrics = doc.steps[0]?.metrics;

    expect(metrics?.prompt_tokens).toBe(100);
    expect(metrics?.completion_tokens).toBe(50);
    expect(metrics?.cached_tokens).toBe(20);
    expect(metrics?.cost_usd).toBe(0.005);
  });

  test("includes reasoning_content when present", () => {
    const step = makeAgentStep({ reasoningContent: "Let me think..." });
    const doc = mapRichTrajectoryToAtif([step], { sessionId: "s1", agentName: "a" });

    const atifStep = doc.steps[0] as AtifAgentStep;
    expect(atifStep?.reasoning_content).toBe("Let me think...");
  });

  test("maps step metadata to extra field", () => {
    const step = makeAgentStep({ metadata: { custom: "value" } });
    const doc = mapRichTrajectoryToAtif([step], { sessionId: "s1", agentName: "a" });
    expect(doc.steps[0]?.extra).toEqual({ custom: "value" });
  });
});

// ---------------------------------------------------------------------------
// computeFinalMetrics
// ---------------------------------------------------------------------------

describe("computeFinalMetrics", () => {
  test("returns undefined for steps without metrics", () => {
    const steps = [makeUserStep()];
    expect(computeFinalMetrics(steps)).toBeUndefined();
  });

  test("sums metrics from all steps", () => {
    const steps = [
      makeAgentStep({ metrics: { promptTokens: 100, completionTokens: 50 } }),
      makeAgentStep({ stepIndex: 1, metrics: { promptTokens: 200, completionTokens: 100 } }),
    ];
    const result = computeFinalMetrics(steps);
    expect(result?.total_prompt_tokens).toBe(300);
    expect(result?.total_completion_tokens).toBe(150);
    expect(result?.total_steps).toBe(2);
  });

  test("handles mixed metrics (some fields present, some not)", () => {
    const steps = [
      makeAgentStep({ metrics: { promptTokens: 100 } }),
      makeAgentStep({ stepIndex: 1, metrics: { completionTokens: 50 } }),
    ];
    const result = computeFinalMetrics(steps);
    expect(result?.total_prompt_tokens).toBe(100);
    expect(result?.total_completion_tokens).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Reverse mapping: ATIF → Rich
// ---------------------------------------------------------------------------

describe("mapAtifToRichTrajectory", () => {
  test("maps agent step back to Rich", () => {
    const doc: AtifDocument = {
      schema_version: ATIF_SCHEMA_VERSION,
      session_id: "s1",
      agent: { name: "test" },
      steps: [
        {
          step_id: 0,
          source: "agent",
          timestamp: "2023-11-14T22:13:20.000Z",
          message: "Hello",
          model_name: "claude",
          outcome: "success",
          duration_ms: 1500,
          observation: { results: [{ content: "Hi!" }] },
          metrics: { prompt_tokens: 100, completion_tokens: 50 },
        },
      ],
    };

    const [step] = mapAtifToRichTrajectory(doc);
    expect(step?.source).toBe("agent");
    expect(step?.kind).toBe("model_call");
    expect(step?.identifier).toBe("claude");
    expect(step?.outcome).toBe("success");
    expect(step?.durationMs).toBe(1500);
    expect(step?.request?.text).toBe("Hello");
    expect(step?.response?.text).toBe("Hi!");
    expect(step?.metrics?.promptTokens).toBe(100);
  });

  test("maps tool step back to Rich", () => {
    const doc: AtifDocument = {
      schema_version: ATIF_SCHEMA_VERSION,
      session_id: "s1",
      agent: { name: "test" },
      steps: [
        {
          step_id: 1,
          source: "tool",
          timestamp: "2023-11-14T22:13:21.000Z",
          tool_calls: [{ tool_call_id: "tc1", function_name: "search" }],
          observation: { results: [{ content: "results", source_call_id: "tc1" }] },
          outcome: "success",
          duration_ms: 500,
        },
      ],
    };

    const [step] = mapAtifToRichTrajectory(doc);
    expect(step?.source).toBe("tool");
    expect(step?.kind).toBe("tool_call");
    expect(step?.identifier).toBe("search");
    expect(step?.response?.text).toBe("results");
  });

  test("maps user step back to Rich", () => {
    const doc: AtifDocument = {
      schema_version: ATIF_SCHEMA_VERSION,
      session_id: "s1",
      agent: { name: "test" },
      steps: [{ step_id: 2, source: "user", timestamp: "2023-11-14T22:13:22.000Z", message: "Hi" }],
    };

    const [step] = mapAtifToRichTrajectory(doc);
    expect(step?.source).toBe("user");
    expect(step?.request?.text).toBe("Hi");
    expect(step?.identifier).toBe("user");
  });

  test("defaults durationMs to 0 when absent", () => {
    const doc: AtifDocument = {
      schema_version: ATIF_SCHEMA_VERSION,
      session_id: "s1",
      agent: { name: "test" },
      steps: [{ step_id: 0, source: "user", timestamp: "2023-11-14T22:13:20.000Z", message: "Hi" }],
    };
    const [step] = mapAtifToRichTrajectory(doc);
    expect(step?.durationMs).toBe(0);
  });

  test("infers outcome as failure when no observation or message", () => {
    const doc: AtifDocument = {
      schema_version: ATIF_SCHEMA_VERSION,
      session_id: "s1",
      agent: { name: "test" },
      steps: [
        {
          step_id: 0,
          source: "agent",
          timestamp: "2023-11-14T22:13:20.000Z",
        },
      ],
    };
    const [step] = mapAtifToRichTrajectory(doc);
    expect(step?.outcome).toBe("failure");
  });
});

// ---------------------------------------------------------------------------
// Round-trip: Rich → ATIF → Rich (with lossy-field documentation)
// ---------------------------------------------------------------------------

describe("round-trip: Rich → ATIF → Rich", () => {
  test("agent model_call step preserves non-lossy fields", () => {
    const original = makeAgentStep();
    const doc = mapRichTrajectoryToAtif([original], { sessionId: "s1", agentName: "a" });
    const [roundTripped] = mapAtifToRichTrajectory(doc);

    expect(roundTripped?.stepIndex).toBe(original.stepIndex);
    expect(roundTripped?.source).toBe(original.source);
    expect(roundTripped?.kind).toBe(original.kind);
    expect(roundTripped?.identifier).toBe(original.identifier);
    expect(roundTripped?.outcome).toBe(original.outcome);
    expect(roundTripped?.durationMs).toBe(original.durationMs);
    expect(roundTripped?.request?.text).toBe(original.request?.text);
    expect(roundTripped?.response?.text).toBe(original.response?.text);
    expect(roundTripped?.metrics?.promptTokens).toBe(original.metrics?.promptTokens);
    expect(roundTripped?.metrics?.completionTokens).toBe(original.metrics?.completionTokens);
  });

  test("tool step preserves non-lossy fields including request arguments", () => {
    const original = makeToolStep({ request: { data: { query: "cats", limit: 10 } } });
    const doc = mapRichTrajectoryToAtif([original], { sessionId: "s1", agentName: "a" });
    const [roundTripped] = mapAtifToRichTrajectory(doc);

    expect(roundTripped?.source).toBe("tool");
    expect(roundTripped?.kind).toBe("tool_call");
    expect(roundTripped?.identifier).toBe("web_search");
    expect(roundTripped?.response?.text).toBe("Search results here");
    // Tool arguments must survive the round-trip (Fix: Codex adversarial finding)
    expect(roundTripped?.request?.data).toEqual({ query: "cats", limit: 10 });
  });

  test("user step round-trips cleanly", () => {
    const original = makeUserStep();
    const doc = mapRichTrajectoryToAtif([original], { sessionId: "s1", agentName: "a" });
    const [roundTripped] = mapAtifToRichTrajectory(doc);

    expect(roundTripped?.source).toBe("user");
    expect(roundTripped?.request?.text).toBe(original.request?.text);
    expect(roundTripped?.outcome).toBe("success");
  });

  test("system step round-trips cleanly", () => {
    const original = makeSystemStep();
    const doc = mapRichTrajectoryToAtif([original], { sessionId: "s1", agentName: "a" });
    const [roundTripped] = mapAtifToRichTrajectory(doc);

    expect(roundTripped?.source).toBe("system");
    expect(roundTripped?.request?.text).toBe(original.request?.text);
  });

  test("LOSSY: timestamp — ms precision preserved through ISO 8601", () => {
    const original = makeAgentStep({ timestamp: 1700000000123 });
    const doc = mapRichTrajectoryToAtif([original], { sessionId: "s1", agentName: "a" });
    const [roundTripped] = mapAtifToRichTrajectory(doc);

    // ISO 8601 has ms precision, so round-trip preserves it
    expect(roundTripped?.timestamp).toBe(1700000000123);
  });

  test("LOSSY: outcome is preserved when explicitly set", () => {
    const original = makeAgentStep({ outcome: "retry" });
    const doc = mapRichTrajectoryToAtif([original], { sessionId: "s1", agentName: "a" });
    const [roundTripped] = mapAtifToRichTrajectory(doc);

    expect(roundTripped?.outcome).toBe("retry");
  });

  test("multiple steps in sequence", () => {
    const steps = [makeAgentStep(), makeToolStep(), makeUserStep(), makeSystemStep()];
    const doc = mapRichTrajectoryToAtif(steps, { sessionId: "s1", agentName: "a" });
    const roundTripped = mapAtifToRichTrajectory(doc);

    expect(roundTripped).toHaveLength(4);
    expect(roundTripped[0]?.source).toBe("agent");
    expect(roundTripped[1]?.source).toBe("tool");
    expect(roundTripped[2]?.source).toBe("user");
    expect(roundTripped[3]?.source).toBe("system");
  });
});

// ---------------------------------------------------------------------------
// Flat serialization helpers
// ---------------------------------------------------------------------------

describe("flattenStep / parseStep", () => {
  test("round-trips agent step through flat format", () => {
    const original = makeAgentStep();
    const doc = mapRichTrajectoryToAtif([original], { sessionId: "s1", agentName: "a" });
    const step = doc.steps[0];
    if (step === undefined) throw new Error("expected step");

    const flat = flattenStep(step);
    const parsed = parseStep(flat);
    expect(parsed.source).toBe("agent");
    expect(parsed.step_id).toBe(step.step_id);
  });

  test("round-trips tool step through flat format", () => {
    const original = makeToolStep();
    const doc = mapRichTrajectoryToAtif([original], { sessionId: "s1", agentName: "a" });
    const step = doc.steps[0];
    if (step === undefined) throw new Error("expected step");

    const flat = flattenStep(step);
    const parsed = parseStep(flat);
    expect(parsed.source).toBe("tool");
  });
});
