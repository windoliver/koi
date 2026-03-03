/**
 * Integration tests for @koi/engine-rlm.
 *
 * Uses scripted mock model responses for deterministic, CI-friendly testing.
 * Verifies the full pipeline: tool dispatch, metadata injection, compaction,
 * batched queries, and recursive spawning.
 */

import { describe, expect, mock, test } from "bun:test";
import type { EngineEvent, EngineOutput, ModelHandler, ModelRequest } from "@koi/core";
import { createRlmAdapter } from "../adapter.js";
import type { RlmConfig, RlmSpawnRequest } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(stream: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function findDoneEvent(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e) => e.kind === "done");
  return done?.kind === "done" ? done.output : undefined;
}

function createMinimalConfig(modelCall: ModelHandler): RlmConfig {
  return {
    modelCall,
    maxIterations: 20,
    maxInputBytes: 100_000,
    chunkSize: 50,
    previewLength: 30,
    contextWindowTokens: 50_000,
    maxConcurrency: 3,
  };
}

// ---------------------------------------------------------------------------
// E2E: 4-round full pipeline
// ---------------------------------------------------------------------------

describe("e2e: 4-round full pipeline", () => {
  test("input_info → chunk → examine → llm_query → FINAL", async () => {
    const largeInput =
      '{"data": ' +
      JSON.stringify(Array.from({ length: 100 }, (_, i) => `item-${String(i)}`)) +
      "}";

    // let: turn counter for scripted responses
    let turn = 0;
    const modelCall: ModelHandler = mock(async (_req: ModelRequest) => {
      turn++;
      switch (turn) {
        case 1:
          // Model calls input_info
          return {
            content: "Let me examine the input.",
            model: "test",
            metadata: {
              toolCalls: [{ toolName: "input_info", callId: "c1", input: {} }],
            },
          };
        case 2:
          // Model calls chunk to see structure
          return {
            content: "Getting chunk overview.",
            model: "test",
            metadata: {
              toolCalls: [
                { toolName: "chunk", callId: "c2", input: { start_index: 0, end_index: 2 } },
              ],
            },
          };
        case 3:
          // Model calls examine to read first chunk
          return {
            content: "Reading first chunk.",
            model: "test",
            metadata: {
              toolCalls: [{ toolName: "examine", callId: "c3", input: { offset: 0, length: 100 } }],
            },
          };
        case 4:
          // Model calls llm_query to analyze
          return {
            content: "Analyzing content.",
            model: "test",
            metadata: {
              toolCalls: [
                {
                  toolName: "llm_query",
                  callId: "c4",
                  input: { prompt: "Summarize: item-0 through item-99" },
                },
              ],
            },
          };
        case 5:
          // Sub-model call from llm_query — returns analysis result
          return {
            content: "Summary: 100 items from item-0 to item-99.",
            model: "test",
          };
        case 6:
          // REPL model sees llm_query result, calls FINAL
          return {
            content: "I have the answer.",
            model: "test",
            metadata: {
              toolCalls: [
                {
                  toolName: "FINAL",
                  callId: "c5",
                  input: { answer: "The input contains 100 items from item-0 to item-99." },
                },
              ],
            },
          };
        default:
          return { content: "unexpected", model: "test" };
      }
    });

    const adapter = createRlmAdapter(createMinimalConfig(modelCall));
    const events = await collectEvents(adapter.stream({ kind: "text", text: largeInput }));

    const output = findDoneEvent(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("completed");
    if (output?.content[0]?.kind === "text") {
      expect(output.content[0].text).toContain("100 items");
    }

    // Verify tool call events were emitted
    const toolStarts = events.filter((e) => e.kind === "tool_call_start");
    const toolEnds = events.filter((e) => e.kind === "tool_call_end");
    expect(toolStarts.length).toBe(5); // input_info, chunk, examine, llm_query, FINAL
    expect(toolEnds.length).toBe(5);

    // Verify turn events: 5 REPL turns (llm_query sub-call doesn't count as a turn)
    const turnStarts = events.filter((e) => e.kind === "turn_start");
    expect(turnStarts.length).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// E2E: llm_query_batched concurrency
// ---------------------------------------------------------------------------

describe("e2e: llm_query_batched concurrency", () => {
  test("3 prompts execute with semaphore respected", async () => {
    // let: track concurrency
    let maxConcurrent = 0;
    let currentConcurrent = 0;
    // let: turn counter
    let turn = 0;

    const modelCall: ModelHandler = mock(async (req: ModelRequest) => {
      turn++;

      // Turns 1: the REPL model calls llm_query_batched
      if (turn === 1) {
        return {
          content: "Running batch queries.",
          model: "test",
          metadata: {
            toolCalls: [
              {
                toolName: "llm_query_batched",
                callId: "batch-1",
                input: { prompts: ["What is 1+1?", "What is 2+2?", "What is 3+3?"] },
              },
            ],
          },
        };
      }

      // Sub-calls from llm_query_batched (turns 2-4) — these go through the model
      if (turn <= 4) {
        currentConcurrent++;
        if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
        await new Promise((r) => setTimeout(r, 20));
        currentConcurrent--;
        const text = req.messages[0]?.content[0];
        const prompt = text?.kind === "text" ? text.text : "";
        return { content: `Answer to: ${prompt}`, model: "test" };
      }

      // Turn 5: model sees batch results and calls FINAL
      return {
        content: "All done.",
        model: "test",
        metadata: {
          toolCalls: [
            { toolName: "FINAL", callId: "final-1", input: { answer: "Batch results: 2, 4, 6" } },
          ],
        },
      };
    });

    const adapter = createRlmAdapter({
      ...createMinimalConfig(modelCall),
      maxConcurrency: 2, // Limit to 2 concurrent
    });

    const events = await collectEvents(adapter.stream({ kind: "text", text: "batch test input" }));

    const output = findDoneEvent(events);
    expect(output?.stopReason).toBe("completed");
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// E2E: rlm_query spawning
// ---------------------------------------------------------------------------

describe("e2e: rlm_query spawning", () => {
  test("dispatches with correct depth=1", async () => {
    const spawnRlmChild = mock(async (req: RlmSpawnRequest) => {
      expect(req.depth).toBe(1);
      expect(req.input).toBe("sub-document content");
      expect(req.remainingTokenBudget).toBeGreaterThan(0);
      return { answer: "Child processed: sub-document summary", tokensUsed: 50 };
    });

    // let: turn counter
    let turn = 0;
    const modelCall: ModelHandler = mock(async () => {
      turn++;
      if (turn === 1) {
        return {
          content: "Need to process sub-document.",
          model: "test",
          metadata: {
            toolCalls: [
              {
                toolName: "rlm_query",
                callId: "spawn-1",
                input: { input: "sub-document content" },
              },
            ],
          },
        };
      }
      return {
        content: "Got result.",
        model: "test",
        metadata: {
          toolCalls: [
            {
              toolName: "FINAL",
              callId: "final-1",
              input: { answer: "Sub-document summary received." },
            },
          ],
        },
      };
    });

    const adapter = createRlmAdapter({
      ...createMinimalConfig(modelCall),
      spawnRlmChild,
      depth: 0,
    });

    const events = await collectEvents(adapter.stream({ kind: "text", text: "main document" }));

    const output = findDoneEvent(events);
    expect(output?.stopReason).toBe("completed");
    expect(spawnRlmChild).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// E2E: metadata stub in first model call
// ---------------------------------------------------------------------------

describe("e2e: metadata stub", () => {
  test("first model call includes input metadata in system context", async () => {
    // let: capture first call
    let firstCallMessages: readonly unknown[] | undefined;

    const modelCall: ModelHandler = mock(async (req: ModelRequest) => {
      if (firstCallMessages === undefined) {
        firstCallMessages = req.messages;
      }
      return {
        content: "Quick answer.",
        model: "test",
      };
    });

    const adapter = createRlmAdapter(createMinimalConfig(modelCall));
    await collectEvents(
      adapter.stream({ kind: "text", text: '{"key": "value", "items": [1,2,3]}' }),
    );

    expect(firstCallMessages).toBeDefined();
    const firstMsg = firstCallMessages?.[0] as
      | { readonly content: readonly { readonly kind: string; readonly text?: string }[] }
      | undefined;
    const text = firstMsg?.content[0]?.kind === "text" ? (firstMsg.content[0].text ?? "") : "";

    // Should contain metadata about the input
    expect(text).toContain("Format: json");
    expect(text).toContain("Chunks:");
    expect(text).toContain("Structure hints:");
  });
});

// ---------------------------------------------------------------------------
// E2E: compaction fires at correct iteration
// ---------------------------------------------------------------------------

describe("e2e: compaction", () => {
  test("fires when utilization exceeds threshold", async () => {
    // let: turn counter
    let turn = 0;
    const modelCall: ModelHandler = mock(async () => {
      turn++;
      // Always call input_info to keep the loop going, with verbose content
      return {
        content: "x".repeat(500), // ~125 tokens per response
        model: "test",
        metadata: {
          toolCalls:
            turn < 6
              ? [{ toolName: "input_info", callId: `c${String(turn)}`, input: {} }]
              : [
                  {
                    toolName: "FINAL",
                    callId: "final",
                    input: { answer: "done after compaction" },
                  },
                ],
        },
      };
    });

    const adapter = createRlmAdapter({
      ...createMinimalConfig(modelCall),
      contextWindowTokens: 200, // Very small to trigger compaction
      compactionThreshold: 0.5,
      maxIterations: 10,
    });

    const events = await collectEvents(adapter.stream({ kind: "text", text: "test input" }));

    const compactionEvents = events.filter(
      (e) => e.kind === "custom" && (e as { readonly type: string }).type === "rlm:compaction",
    );
    expect(compactionEvents.length).toBeGreaterThan(0);

    const output = findDoneEvent(events);
    expect(output).toBeDefined();
  });
});
