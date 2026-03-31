import { describe, expect, test } from "bun:test";
import type { RichTrajectoryStep } from "@koi/core/rich-trajectory";
import {
  type AtifDocument,
  type AtifExportOptions,
  type AtifStep,
  mapAtifToRichTrajectory,
  mapRichTrajectoryToAtif,
} from "./atif.js";

/** Safe array access for tests — throws instead of returning undefined. */
function at<T>(arr: readonly T[], index: number): T {
  const value = arr[index];
  if (value === undefined) throw new Error(`No element at index ${index}`);
  return value;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_TIMESTAMP = 1700000000000; // 2023-11-14T22:13:20.000Z

function createOptions(overrides?: Partial<AtifExportOptions>): AtifExportOptions {
  return {
    sessionId: "sess-001",
    agentName: "test-agent",
    ...overrides,
  };
}

function createModelCallStep(overrides?: Partial<RichTrajectoryStep>): RichTrajectoryStep {
  return {
    stepIndex: 0,
    timestamp: BASE_TIMESTAMP,
    source: "agent",
    kind: "model_call",
    identifier: "gpt-4o",
    outcome: "success",
    durationMs: 1200,
    request: { text: "Hello, world" },
    response: { text: "Hi there!" },
    ...overrides,
  };
}

function createToolCallStep(overrides?: Partial<RichTrajectoryStep>): RichTrajectoryStep {
  return {
    stepIndex: 1,
    timestamp: BASE_TIMESTAMP + 1000,
    source: "tool",
    kind: "tool_call",
    identifier: "read_file",
    outcome: "success",
    durationMs: 300,
    request: { text: "Reading file", data: { path: "/src/index.ts" } },
    response: { text: "file contents here" },
    ...overrides,
  };
}

function createMinimalAtifDoc(overrides?: Partial<AtifDocument>): AtifDocument {
  return {
    schema_version: "ATIF-v1.6",
    session_id: "sess-001",
    agent: { name: "test-agent" },
    steps: [],
    ...overrides,
  };
}

function createAtifModelStep(overrides?: Partial<AtifStep>): AtifStep {
  return {
    step_id: 0,
    source: "agent",
    timestamp: new Date(BASE_TIMESTAMP).toISOString(),
    model_name: "gpt-4o",
    message: "Hello, world",
    ...overrides,
  };
}

function createAtifToolStep(overrides?: Partial<AtifStep>): AtifStep {
  return {
    step_id: 1,
    source: "tool",
    timestamp: new Date(BASE_TIMESTAMP + 1000).toISOString(),
    tool_calls: [
      {
        tool_call_id: "call_read_file_1",
        function_name: "read_file",
        arguments: { path: "/src/index.ts" },
      },
    ],
    observation: {
      results: [
        {
          source_call_id: "call_read_file_1",
          content: "file contents here",
        },
      ],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Export: mapRichTrajectoryToAtif
// ---------------------------------------------------------------------------

describe("mapRichTrajectoryToAtif", () => {
  test("empty steps produces document with empty steps array", () => {
    const doc = mapRichTrajectoryToAtif([], createOptions());
    expect(doc.steps).toEqual([]);
    expect(doc.schema_version).toBe("ATIF-v1.6");
    expect(doc.session_id).toBe("sess-001");
    expect(doc.agent.name).toBe("test-agent");
  });

  test("schema_version is always ATIF-v1.6", () => {
    const doc = mapRichTrajectoryToAtif([createModelCallStep()], createOptions());
    expect(doc.schema_version).toBe("ATIF-v1.6");
  });

  test("model call step maps to ATIF step with model_name and message", () => {
    const doc = mapRichTrajectoryToAtif([createModelCallStep()], createOptions());
    expect(doc.steps).toHaveLength(1);
    const step = at(doc.steps, 0);
    expect(step.model_name).toBe("gpt-4o");
    expect(step.message).toBe("Hello, world");
    expect(step.step_id).toBe(0);
    expect(step.source).toBe("agent");
    expect(step.tool_calls).toBeUndefined();
  });

  test("tool call step maps to ATIF step with tool_calls and observation", () => {
    const doc = mapRichTrajectoryToAtif([createToolCallStep()], createOptions());
    expect(doc.steps).toHaveLength(1);
    const step = at(doc.steps, 0);
    expect(step.tool_calls).toBeDefined();
    expect(step.tool_calls).toHaveLength(1);
    expect(step.tool_calls?.[0]?.function_name).toBe("read_file");
    expect(step.tool_calls?.[0]?.arguments).toEqual({ path: "/src/index.ts" });
    expect(step.observation).toBeDefined();
    expect(step.observation?.results).toHaveLength(1);
    expect(step.observation?.results?.[0]?.content).toBe("file contents here");
    // model_name should not be set for tool calls
    expect(step.model_name).toBeUndefined();
  });

  test("reasoning content is preserved", () => {
    const step = createModelCallStep({
      reasoningContent: "Let me think about this step by step...",
    });
    const doc = mapRichTrajectoryToAtif([step], createOptions());
    expect(doc.steps[0]?.reasoning_content).toBe("Let me think about this step by step...");
  });

  test("metrics mapped with camelCase to snake_case", () => {
    const step = createModelCallStep({
      metrics: {
        promptTokens: 100,
        completionTokens: 50,
        cachedTokens: 20,
        costUsd: 0.003,
      },
    });
    const doc = mapRichTrajectoryToAtif([step], createOptions());
    const metrics = at(doc.steps, 0).metrics;
    if (metrics === undefined) throw new Error("expected metrics");
    expect(metrics.prompt_tokens).toBe(100);
    expect(metrics.completion_tokens).toBe(50);
    expect(metrics.cached_tokens).toBe(20);
    expect(metrics.cost_usd).toBe(0.003);
  });

  test("final metrics computed from step metrics (summed)", () => {
    const steps: readonly RichTrajectoryStep[] = [
      createModelCallStep({
        stepIndex: 0,
        metrics: { promptTokens: 100, completionTokens: 50, costUsd: 0.002 },
      }),
      createModelCallStep({
        stepIndex: 1,
        metrics: { promptTokens: 200, completionTokens: 80, costUsd: 0.004 },
      }),
    ];
    const doc = mapRichTrajectoryToAtif(steps, createOptions());
    expect(doc.final_metrics).toBeDefined();
    expect(doc.final_metrics?.total_prompt_tokens).toBe(300);
    expect(doc.final_metrics?.total_completion_tokens).toBe(130);
    expect(doc.final_metrics?.total_cost_usd).toBeCloseTo(0.006);
    expect(doc.final_metrics?.total_steps).toBe(2);
  });

  test("final metrics omitted when no steps have metrics", () => {
    const steps: readonly RichTrajectoryStep[] = [createModelCallStep({})];
    const doc = mapRichTrajectoryToAtif(steps, createOptions());
    expect(doc.final_metrics).toBeUndefined();
  });

  test("metadata mapped to extra field", () => {
    const step = createModelCallStep({
      metadata: { customKey: "customValue", nested: { a: 1 } },
    });
    const doc = mapRichTrajectoryToAtif([step], createOptions());
    expect(doc.steps[0]?.extra).toEqual({ customKey: "customValue", nested: { a: 1 } });
  });

  test("notes and agentVersion passed through", () => {
    const doc = mapRichTrajectoryToAtif(
      [],
      createOptions({ agentVersion: "1.2.3", notes: "Test session" }),
    );
    expect(doc.agent.version).toBe("1.2.3");
    expect(doc.notes).toBe("Test session");
  });

  test("agentVersion omitted when not provided", () => {
    const doc = mapRichTrajectoryToAtif([], createOptions());
    expect(doc.agent.version).toBeUndefined();
  });

  test("notes omitted when not provided", () => {
    const doc = mapRichTrajectoryToAtif([], createOptions());
    expect(doc.notes).toBeUndefined();
  });

  test("timestamp converted to ISO 8601 string", () => {
    const step = createModelCallStep({ timestamp: BASE_TIMESTAMP });
    const doc = mapRichTrajectoryToAtif([step], createOptions());
    expect(doc.steps[0]?.timestamp).toBe(new Date(BASE_TIMESTAMP).toISOString());
  });

  test("duration_ms mapped from durationMs", () => {
    const step = createModelCallStep({ durationMs: 3500 });
    const doc = mapRichTrajectoryToAtif([step], createOptions());
    expect(doc.steps[0]?.duration_ms).toBe(3500);
  });

  test("outcome mapped directly", () => {
    const step = createModelCallStep({ outcome: "retry" });
    const doc = mapRichTrajectoryToAtif([step], createOptions());
    expect(doc.steps[0]?.outcome).toBe("retry");
  });

  test("tool call without response has no observation", () => {
    const { response: _, ...noResponse } = createToolCallStep();
    const step: RichTrajectoryStep = noResponse;
    const doc = mapRichTrajectoryToAtif([step], createOptions());
    expect(doc.steps[0]?.observation).toBeUndefined();
  });

  test("tool call with request data maps to arguments", () => {
    const step = createToolCallStep({
      request: { data: { query: "SELECT 1" } },
    });
    const doc = mapRichTrajectoryToAtif([step], createOptions());
    expect(doc.steps[0]?.tool_calls?.[0]?.arguments).toEqual({ query: "SELECT 1" });
  });

  test("tool_call_id includes identifier and stepIndex", () => {
    const step = createToolCallStep({ stepIndex: 7, identifier: "search" });
    const doc = mapRichTrajectoryToAtif([step], createOptions());
    expect(doc.steps[0]?.tool_calls?.[0]?.tool_call_id).toBe("call_search_7");
  });

  test("partial metrics only include defined fields", () => {
    const step = createModelCallStep({
      metrics: { promptTokens: 42 },
    });
    const doc = mapRichTrajectoryToAtif([step], createOptions());
    const metrics = at(doc.steps, 0).metrics;
    if (metrics === undefined) throw new Error("expected metrics");
    expect(metrics.prompt_tokens).toBe(42);
    expect(metrics.completion_tokens).toBeUndefined();
    expect(metrics.cached_tokens).toBeUndefined();
    expect(metrics.cost_usd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Import: mapAtifToRichTrajectory
// ---------------------------------------------------------------------------

describe("mapAtifToRichTrajectory", () => {
  test("empty steps produces empty array", () => {
    const doc = createMinimalAtifDoc({ steps: [] });
    const steps = mapAtifToRichTrajectory(doc);
    expect(steps).toEqual([]);
  });

  test("ATIF model call maps to RichTrajectoryStep with kind=model_call", () => {
    const doc = createMinimalAtifDoc({
      steps: [createAtifModelStep()],
    });
    const steps = mapAtifToRichTrajectory(doc);
    expect(steps).toHaveLength(1);
    const step = at(steps, 0);
    expect(step.kind).toBe("model_call");
    expect(step.identifier).toBe("gpt-4o");
    expect(step.source).toBe("agent");
    expect(step.request?.text).toBe("Hello, world");
  });

  test("ATIF tool call maps to RichTrajectoryStep with kind=tool_call", () => {
    const doc = createMinimalAtifDoc({
      steps: [createAtifToolStep()],
    });
    const steps = mapAtifToRichTrajectory(doc);
    expect(steps).toHaveLength(1);
    const step = at(steps, 0);
    expect(step.kind).toBe("tool_call");
    expect(step.identifier).toBe("read_file");
    expect(step.response?.text).toBe("file contents here");
  });

  test("timestamp string parsed to number (ISO 8601)", () => {
    const isoString = "2023-11-14T22:13:20.000Z";
    const doc = createMinimalAtifDoc({
      steps: [createAtifModelStep({ timestamp: isoString })],
    });
    const steps = mapAtifToRichTrajectory(doc);
    expect(steps[0]?.timestamp).toBe(new Date(isoString).getTime());
  });

  test("metrics mapped with snake_case to camelCase", () => {
    const doc = createMinimalAtifDoc({
      steps: [
        createAtifModelStep({
          metrics: {
            prompt_tokens: 100,
            completion_tokens: 50,
            cached_tokens: 20,
            cost_usd: 0.003,
          },
        }),
      ],
    });
    const steps = mapAtifToRichTrajectory(doc);
    const metrics = at(steps, 0).metrics;
    if (metrics === undefined) throw new Error("expected metrics");
    expect(metrics.promptTokens).toBe(100);
    expect(metrics.completionTokens).toBe(50);
    expect(metrics.cachedTokens).toBe(20);
    expect(metrics.costUsd).toBe(0.003);
  });

  test("missing optional fields handled gracefully", () => {
    const doc = createMinimalAtifDoc({
      steps: [
        {
          step_id: 0,
          source: "agent" as const,
          timestamp: new Date(BASE_TIMESTAMP).toISOString(),
        },
      ],
    });
    const steps = mapAtifToRichTrajectory(doc);
    expect(steps).toHaveLength(1);
    const step = at(steps, 0);
    expect(step.request).toBeUndefined();
    expect(step.response).toBeUndefined();
    expect(step.reasoningContent).toBeUndefined();
    expect(step.metrics).toBeUndefined();
    expect(step.metadata).toBeUndefined();
  });

  test("extra field mapped to metadata", () => {
    const doc = createMinimalAtifDoc({
      steps: [
        createAtifModelStep({
          extra: { customKey: "customValue" },
        }),
      ],
    });
    const steps = mapAtifToRichTrajectory(doc);
    expect(steps[0]?.metadata).toEqual({ customKey: "customValue" });
  });

  test("reasoning_content mapped to reasoningContent", () => {
    const doc = createMinimalAtifDoc({
      steps: [
        createAtifModelStep({
          reasoning_content: "I need to think carefully...",
        }),
      ],
    });
    const steps = mapAtifToRichTrajectory(doc);
    expect(steps[0]?.reasoningContent).toBe("I need to think carefully...");
  });

  test("durationMs defaults to 0 when duration_ms absent in ATIF step", () => {
    const doc = createMinimalAtifDoc({
      steps: [createAtifModelStep()],
    });
    const steps = mapAtifToRichTrajectory(doc);
    expect(steps[0]?.durationMs).toBe(0);
  });

  test("durationMs read from duration_ms when present", () => {
    const doc = createMinimalAtifDoc({
      steps: [createAtifModelStep({ duration_ms: 2500 })],
    });
    const steps = mapAtifToRichTrajectory(doc);
    expect(steps[0]?.durationMs).toBe(2500);
  });

  test("outcome read from explicit field when present", () => {
    const doc = createMinimalAtifDoc({
      steps: [createAtifModelStep({ outcome: "retry" })],
    });
    const steps = mapAtifToRichTrajectory(doc);
    expect(steps[0]?.outcome).toBe("retry");
  });

  test("outcome inferred as success when model step has message", () => {
    const doc = createMinimalAtifDoc({
      steps: [createAtifModelStep({ message: "response text" })],
    });
    const steps = mapAtifToRichTrajectory(doc);
    expect(steps[0]?.outcome).toBe("success");
  });

  test("outcome inferred as success when tool step has observation results", () => {
    const doc = createMinimalAtifDoc({
      steps: [createAtifToolStep()],
    });
    const steps = mapAtifToRichTrajectory(doc);
    expect(steps[0]?.outcome).toBe("success");
  });

  test("outcome inferred as failure when no message and no observation", () => {
    const doc = createMinimalAtifDoc({
      steps: [
        {
          step_id: 0,
          source: "agent" as const,
          timestamp: new Date(BASE_TIMESTAMP).toISOString(),
        },
      ],
    });
    const steps = mapAtifToRichTrajectory(doc);
    expect(steps[0]?.outcome).toBe("failure");
  });

  test("identifier defaults to unknown when model_name missing", () => {
    const doc = createMinimalAtifDoc({
      steps: [
        {
          step_id: 0,
          source: "agent" as const,
          timestamp: new Date(BASE_TIMESTAMP).toISOString(),
          message: "hello",
        },
      ],
    });
    const steps = mapAtifToRichTrajectory(doc);
    expect(steps[0]?.identifier).toBe("unknown");
  });

  test("partial metrics only include defined fields", () => {
    const doc = createMinimalAtifDoc({
      steps: [
        createAtifModelStep({
          metrics: { prompt_tokens: 42 },
        }),
      ],
    });
    const steps = mapAtifToRichTrajectory(doc);
    const metrics = at(steps, 0).metrics;
    if (metrics === undefined) throw new Error("expected metrics");
    expect(metrics.promptTokens).toBe(42);
    expect(metrics.completionTokens).toBeUndefined();
    expect(metrics.cachedTokens).toBeUndefined();
    expect(metrics.costUsd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Roundtrip fidelity
// ---------------------------------------------------------------------------

describe("roundtrip fidelity", () => {
  test("model call step preserves key fields through export/import", () => {
    const original = createModelCallStep({
      stepIndex: 3,
      source: "agent",
      kind: "model_call",
      identifier: "claude-3-opus",
      request: { text: "Explain quantum computing" },
      reasoningContent: "Let me break this down...",
    });

    const doc = mapRichTrajectoryToAtif([original], createOptions());
    const imported = mapAtifToRichTrajectory(doc);

    expect(imported).toHaveLength(1);
    const roundtripped = at(imported, 0);
    expect(roundtripped.stepIndex).toBe(3);
    expect(roundtripped.source).toBe("agent");
    expect(roundtripped.kind).toBe("model_call");
    expect(roundtripped.identifier).toBe("claude-3-opus");
    expect(roundtripped.request?.text).toBe("Explain quantum computing");
    expect(roundtripped.reasoningContent).toBe("Let me break this down...");
  });

  test("tool call step preserves key fields through export/import", () => {
    const original = createToolCallStep({
      stepIndex: 5,
      source: "tool",
      kind: "tool_call",
      identifier: "write_file",
      response: { text: "File written successfully" },
    });

    const doc = mapRichTrajectoryToAtif([original], createOptions());
    const imported = mapAtifToRichTrajectory(doc);

    expect(imported).toHaveLength(1);
    const roundtripped = at(imported, 0);
    expect(roundtripped.stepIndex).toBe(5);
    expect(roundtripped.source).toBe("tool");
    expect(roundtripped.kind).toBe("tool_call");
    expect(roundtripped.identifier).toBe("write_file");
    expect(roundtripped.response?.text).toBe("File written successfully");
  });

  test("metrics roundtrip preserves token counts", () => {
    const original = createModelCallStep({
      metrics: {
        promptTokens: 150,
        completionTokens: 75,
        cachedTokens: 30,
        costUsd: 0.005,
      },
    });

    const doc = mapRichTrajectoryToAtif([original], createOptions());
    const imported = mapAtifToRichTrajectory(doc);

    const metrics = at(imported, 0).metrics;
    if (metrics === undefined) throw new Error("expected metrics");
    expect(metrics.promptTokens).toBe(150);
    expect(metrics.completionTokens).toBe(75);
    expect(metrics.cachedTokens).toBe(30);
    expect(metrics.costUsd).toBeCloseTo(0.005);
  });

  test("content text roundtrips through export/import", () => {
    const original = createModelCallStep({
      request: { text: "Multi-line\nrequest\twith special chars: {}" },
    });

    const doc = mapRichTrajectoryToAtif([original], createOptions());
    const imported = mapAtifToRichTrajectory(doc);

    expect(imported[0]?.request?.text).toBe("Multi-line\nrequest\twith special chars: {}");
  });

  test("durationMs and outcome preserved through roundtrip", () => {
    const original = createModelCallStep({
      durationMs: 5000,
      outcome: "retry",
      request: { text: "some message" },
    });

    const doc = mapRichTrajectoryToAtif([original], createOptions());
    const imported = mapAtifToRichTrajectory(doc);

    // duration_ms and outcome are now explicit ATIF fields (Koi extension)
    expect(imported[0]?.durationMs).toBe(5000);
    expect(imported[0]?.outcome).toBe("retry");
  });

  test("timestamp roundtrips through ISO 8601 conversion", () => {
    const original = createModelCallStep({ timestamp: BASE_TIMESTAMP });

    const doc = mapRichTrajectoryToAtif([original], createOptions());
    const imported = mapAtifToRichTrajectory(doc);

    expect(imported[0]?.timestamp).toBe(BASE_TIMESTAMP);
  });

  test("metadata roundtrips through extra field", () => {
    const original = createModelCallStep({
      metadata: { traceId: "abc-123", retryCount: 2 },
    });

    const doc = mapRichTrajectoryToAtif([original], createOptions());
    const imported = mapAtifToRichTrajectory(doc);

    expect(imported[0]?.metadata).toEqual({ traceId: "abc-123", retryCount: 2 });
  });

  test("multiple steps with varying fields roundtrip correctly", () => {
    const steps: readonly RichTrajectoryStep[] = [
      createModelCallStep({
        stepIndex: 0,
        source: "user",
        identifier: "claude-3-sonnet",
        request: { text: "Tell me a joke" },
        metrics: { promptTokens: 10 },
      }),
      createToolCallStep({
        stepIndex: 1,
        source: "tool",
        identifier: "search",
        request: { data: { q: "jokes" } },
        response: { text: "Why did the chicken cross the road?" },
      }),
      createModelCallStep({
        stepIndex: 2,
        source: "system",
        identifier: "gpt-4o-mini",
        reasoningContent: "Formulating response...",
        metadata: { phase: "final" },
      }),
    ];

    const doc = mapRichTrajectoryToAtif(steps, createOptions());
    const imported = mapAtifToRichTrajectory(doc);

    expect(imported).toHaveLength(3);
    expect(imported[0]?.stepIndex).toBe(0);
    expect(imported[0]?.source).toBe("user");
    expect(imported[0]?.kind).toBe("model_call");
    expect(imported[0]?.identifier).toBe("claude-3-sonnet");

    expect(imported[1]?.stepIndex).toBe(1);
    expect(imported[1]?.kind).toBe("tool_call");
    expect(imported[1]?.identifier).toBe("search");
    expect(imported[1]?.response?.text).toBe("Why did the chicken cross the road?");

    expect(imported[2]?.stepIndex).toBe(2);
    expect(imported[2]?.source).toBe("system");
    expect(imported[2]?.reasoningContent).toBe("Formulating response...");
    expect(imported[2]?.metadata).toEqual({ phase: "final" });
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  test("step with no request or response (minimal step)", () => {
    const step: RichTrajectoryStep = {
      stepIndex: 0,
      timestamp: BASE_TIMESTAMP,
      source: "system",
      kind: "model_call",
      identifier: "internal",
      outcome: "success",
      durationMs: 0,
    };
    const doc = mapRichTrajectoryToAtif([step], createOptions());
    const atifStep = at(doc.steps, 0);
    expect(atifStep.message).toBeUndefined();
    expect(atifStep.tool_calls).toBeUndefined();
    expect(atifStep.observation).toBeUndefined();
    expect(atifStep.metrics).toBeUndefined();
    expect(atifStep.extra).toBeUndefined();
  });

  test("step with only error content (no request/response)", () => {
    const { request: _req, response: _res, ...base } = createModelCallStep();
    const step: RichTrajectoryStep = {
      ...base,
      error: { text: "Rate limit exceeded" },
      outcome: "failure",
    };
    const doc = mapRichTrajectoryToAtif([step], createOptions());
    const atifStep = at(doc.steps, 0);
    // Error content is not directly mapped to ATIF (lossy)
    expect(atifStep.message).toBeUndefined();
  });

  test("ATIF step with multiple tool_calls uses first for identifier", () => {
    const doc = createMinimalAtifDoc({
      steps: [
        {
          step_id: 0,
          source: "tool" as const,
          timestamp: new Date(BASE_TIMESTAMP).toISOString(),
          tool_calls: [
            { tool_call_id: "call_1", function_name: "first_tool" },
            { tool_call_id: "call_2", function_name: "second_tool" },
          ],
        },
      ],
    });
    const steps = mapAtifToRichTrajectory(doc);
    expect(steps[0]?.kind).toBe("tool_call");
    expect(steps[0]?.identifier).toBe("first_tool");
  });

  test("ATIF step with no observation results", () => {
    const doc = createMinimalAtifDoc({
      steps: [
        createAtifToolStep({
          observation: { results: [] },
        }),
      ],
    });
    const steps = mapAtifToRichTrajectory(doc);
    expect(steps[0]?.response).toBeUndefined();
    // No observation results means inferred failure (no message either)
    expect(steps[0]?.outcome).toBe("failure");
  });

  test("ATIF step with observation but no results field", () => {
    const doc = createMinimalAtifDoc({
      steps: [
        createAtifToolStep({
          observation: {},
        }),
      ],
    });
    const steps = mapAtifToRichTrajectory(doc);
    expect(steps[0]?.response).toBeUndefined();
  });

  test("ATIF step with empty tool_calls array treated as model_call", () => {
    const doc = createMinimalAtifDoc({
      steps: [
        {
          step_id: 0,
          source: "agent" as const,
          timestamp: new Date(BASE_TIMESTAMP).toISOString(),
          tool_calls: [],
          model_name: "gpt-4o",
          message: "hello",
        },
      ],
    });
    const steps = mapAtifToRichTrajectory(doc);
    expect(steps[0]?.kind).toBe("model_call");
    expect(steps[0]?.identifier).toBe("gpt-4o");
  });

  test("tool call step without request data omits arguments", () => {
    const step = createToolCallStep({
      request: { text: "no data" },
    });
    const doc = mapRichTrajectoryToAtif([step], createOptions());
    expect(doc.steps[0]?.tool_calls?.[0]?.arguments).toBeUndefined();
  });

  test("final metrics only sums fields that are present", () => {
    const steps: readonly RichTrajectoryStep[] = [
      createModelCallStep({
        stepIndex: 0,
        metrics: { promptTokens: 100 },
      }),
      createModelCallStep({
        stepIndex: 1,
        metrics: { completionTokens: 50 },
      }),
    ];
    const doc = mapRichTrajectoryToAtif(steps, createOptions());
    expect(doc.final_metrics?.total_prompt_tokens).toBe(100);
    expect(doc.final_metrics?.total_completion_tokens).toBe(50);
    expect(doc.final_metrics?.total_cached_tokens).toBeUndefined();
    expect(doc.final_metrics?.total_cost_usd).toBeUndefined();
    expect(doc.final_metrics?.total_steps).toBe(2);
  });

  test("mixed steps with and without metrics in final_metrics computation", () => {
    const steps: readonly RichTrajectoryStep[] = [
      createModelCallStep({
        stepIndex: 0,
        metrics: { promptTokens: 100, costUsd: 0.001 },
      }),
      createModelCallStep({
        stepIndex: 1,
      }),
      createToolCallStep({
        stepIndex: 2,
        metrics: { promptTokens: 50, costUsd: 0.002 },
      }),
    ];
    const doc = mapRichTrajectoryToAtif(steps, createOptions());
    expect(doc.final_metrics?.total_prompt_tokens).toBe(150);
    expect(doc.final_metrics?.total_cost_usd).toBeCloseTo(0.003);
    // total_steps counts all steps, not just those with metrics
    expect(doc.final_metrics?.total_steps).toBe(3);
  });

  test("all four source types are preserved", () => {
    const sources = ["agent", "tool", "user", "system"] as const;
    const steps = sources.map((source, i) => createModelCallStep({ stepIndex: i, source }));
    const doc = mapRichTrajectoryToAtif(steps, createOptions());
    const imported = mapAtifToRichTrajectory(doc);

    for (const [i, source] of sources.entries()) {
      expect(imported[i]?.source).toBe(source);
    }
  });
});
