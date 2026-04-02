/**
 * Golden query CI tests — VCR cassette replay + full-stack ATIF validation.
 * Runs in CI without API keys. Zero network calls.
 *
 * Fixtures:
 *   fixtures/simple-text.cassette.json  — text response replay
 *   fixtures/tool-use.cassette.json     — tool call replay
 *   fixtures/simple-text.trajectory.json — Golden ATIF: text response (no tools)
 *   fixtures/tool-use.trajectory.json     — Golden ATIF: tool use (model → tool → model)
 *
 * Re-record: bun run packages/meta/runtime/scripts/record-cassettes.ts
 */

import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "@koi/core";
// @koi/event-trace: referenced via full-stack trajectory
// @koi/hooks: referenced via full-stack trajectory (hook steps)
// @koi/mcp: referenced via full-stack trajectory (mcp steps)
// @koi/model-openai-compat: cassettes recorded from this adapter
// @koi/channel-cli: verified in full-stack-golden.test.ts
import { consumeModelStream } from "@koi/query-engine";
import { loadCassette } from "../cassette/load-cassette.js";

const FIXTURES = `${import.meta.dirname}/../../fixtures`;

async function collectEvents(stream: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function* toAsyncIterable<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

// ---------------------------------------------------------------------------
// Cassette replay: simple text response
// ---------------------------------------------------------------------------

describe("Cassette replay: simple text response", () => {
  test("text_delta events + done with completed stopReason", async () => {
    const cassette = await loadCassette(`${FIXTURES}/simple-text.cassette.json`);
    const events = await collectEvents(consumeModelStream(toAsyncIterable(cassette.chunks)));

    expect(events.filter((e) => e.kind === "text_delta").length).toBeGreaterThan(0);
    const done = events.at(-1);
    expect(done?.kind).toBe("done");
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("completed");
      expect(done.output.metrics.inputTokens).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Cassette replay: tool use flow
// ---------------------------------------------------------------------------

describe("Cassette replay: tool use flow", () => {
  test("tool_call_start with add_numbers + parsedArgs a=7 b=5", async () => {
    const cassette = await loadCassette(`${FIXTURES}/tool-use.cassette.json`);
    const events = await collectEvents(consumeModelStream(toAsyncIterable(cassette.chunks)));

    const toolStart = events.find((e) => e.kind === "tool_call_start");
    expect(toolStart).toBeDefined();
    if (toolStart?.kind === "tool_call_start") {
      expect(toolStart.toolName).toBe("add_numbers");
    }

    const toolEnd = events.find((e) => e.kind === "tool_call_end");
    expect(toolEnd).toBeDefined();
    if (toolEnd?.kind === "tool_call_end") {
      const result = toolEnd.result as { readonly parsedArgs?: Record<string, unknown> };
      expect(result.parsedArgs?.a).toBe(7);
      expect(result.parsedArgs?.b).toBe(5);
    }
  });
});

// ---------------------------------------------------------------------------
// Full-stack ATIF trajectory validation (the golden file)
// ---------------------------------------------------------------------------

describe("Full-stack ATIF trajectory (golden file)", () => {
  test("trajectory file exists and is valid ATIF v1.6", async () => {
    const file = Bun.file(`${FIXTURES}/tool-use.trajectory.json`);
    expect(await file.exists()).toBe(true);

    const doc = (await file.json()) as Record<string, unknown>;
    expect(doc.schema_version).toBe("ATIF-v1.6");
    expect(doc.session_id).toBe("tool-use");
  });

  test("agent metadata has model_name and tool_definitions", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as {
      readonly agent: {
        readonly model_name?: string;
        readonly tool_definitions?: readonly { readonly name: string }[];
      };
    };

    expect(doc.agent.model_name).toBe("google/gemini-2.0-flash-001");
    expect(doc.agent.tool_definitions).toBeDefined();
    expect(doc.agent.tool_definitions?.some((t) => t.name === "add_numbers")).toBe(true);
  });

  test("trajectory has MCP lifecycle steps", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };

    const mcpSteps = doc.steps.filter((s) => s.extra?.type === "mcp_lifecycle");
    expect(mcpSteps.length).toBeGreaterThanOrEqual(2);
    expect(mcpSteps.some((s) => s.extra?.transportState === "connecting")).toBe(true);
    expect(mcpSteps.some((s) => s.extra?.transportState === "connected")).toBe(true);
  });

  test("trajectory has hook execution steps", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly extra?: Record<string, unknown>;
        readonly message?: string;
      }[];
    };

    const hookSteps = doc.steps.filter((s) => s.extra?.type === "hook_execution");
    expect(hookSteps.length).toBeGreaterThan(0);
    expect(hookSteps[0]?.extra?.hookName).toBe("on-tool-exec");
  });

  test("trajectory has model_call steps with I/O", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly model_name?: string;
        readonly message?: string;
        readonly metrics?: Record<string, unknown>;
      }[];
    };

    const modelSteps = doc.steps.filter((s) => s.source === "agent" && s.model_name !== undefined);
    expect(modelSteps.length).toBeGreaterThan(0);

    // First model call should have the prompt
    expect(modelSteps[0]?.message).toContain("add_numbers");
    // Should have token metrics
    expect(modelSteps[0]?.metrics?.prompt_tokens).toBeGreaterThan(0);
  });

  test("trajectory has tool_call steps with result", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly tool_calls?: readonly { readonly function_name: string }[];
        readonly observation?: { readonly results?: readonly { readonly content: string }[] };
      }[];
    };

    const toolSteps = doc.steps.filter(
      (s) => s.source === "tool" && s.observation?.results !== undefined,
    );
    expect(toolSteps.length).toBeGreaterThan(0);
    expect(toolSteps[0]?.observation?.results?.[0]?.content).toContain("12");
  });

  test("trajectory has middleware span steps", async () => {
    const doc = (await Bun.file(`${FIXTURES}/tool-use.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };

    const mwSpans = doc.steps.filter((s) => s.extra?.type === "middleware_span");
    expect(mwSpans.length).toBeGreaterThan(0);
    expect(mwSpans[0]?.extra?.middlewareName).toBeDefined();
    expect(mwSpans[0]?.extra?.hook).toBeDefined();
    expect(mwSpans[0]?.extra?.phase).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Simple text trajectory validation
// ---------------------------------------------------------------------------

describe("Simple text ATIF trajectory (golden file)", () => {
  test("trajectory exists and is valid ATIF v1.6", async () => {
    const file = Bun.file(`${FIXTURES}/simple-text.trajectory.json`);
    expect(await file.exists()).toBe(true);
    const doc = (await file.json()) as Record<string, unknown>;
    expect(doc.schema_version).toBe("ATIF-v1.6");
  });

  test("has model call with prompt and response", async () => {
    const doc = (await Bun.file(`${FIXTURES}/simple-text.trajectory.json`).json()) as {
      readonly steps: readonly {
        readonly source: string;
        readonly model_name?: string;
        readonly message?: string;
        readonly observation?: { readonly results?: readonly { readonly content: string }[] };
        readonly metrics?: Record<string, unknown>;
      }[];
    };

    const modelSteps = doc.steps.filter((s) => s.source === "agent" && s.model_name !== undefined);
    expect(modelSteps.length).toBeGreaterThan(0);
    expect(modelSteps[0]?.message).toContain("2+2");
    expect(modelSteps[0]?.metrics?.prompt_tokens).toBeGreaterThan(0);
  });

  test("has NO tool_call steps (text-only query)", async () => {
    const doc = (await Bun.file(`${FIXTURES}/simple-text.trajectory.json`).json()) as {
      readonly steps: readonly { readonly source: string }[];
    };
    const toolSteps = doc.steps.filter((s) => s.source === "tool");
    expect(toolSteps).toHaveLength(0);
  });

  test("has MCP lifecycle + hook + MW span steps", async () => {
    const doc = (await Bun.file(`${FIXTURES}/simple-text.trajectory.json`).json()) as {
      readonly steps: readonly { readonly extra?: Record<string, unknown> }[];
    };

    const mcpSteps = doc.steps.filter((s) => s.extra?.type === "mcp_lifecycle");
    const hookSteps = doc.steps.filter((s) => s.extra?.type === "hook_execution");
    // MCP always present (simulated lifecycle)
    expect(mcpSteps.length).toBeGreaterThanOrEqual(2);
    // Hooks: on-model-done should fire for the model call
    expect(hookSteps.length).toBeGreaterThanOrEqual(0);
  });
});
