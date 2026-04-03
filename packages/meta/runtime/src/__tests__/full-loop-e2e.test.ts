/**
 * Full agent loop E2E — model → tool → model via createKoi().
 *
 * Uses the real engine agent loop with tool execution.
 * Gated on E2E_TESTS=1 + OPENROUTER_API_KEY.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import type {
  EngineAdapter,
  EngineEvent,
  EngineInput,
  JsonObject,
  ModelChunk,
  Tool,
  ToolDescriptor,
} from "@koi/core";
import { createSingleToolProvider, DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createEventTraceMiddleware } from "@koi/event-trace";
import { createOpenAICompatAdapter } from "@koi/model-openai-compat";
import { consumeModelStream } from "@koi/query-engine";
import { createAtifDocumentStore } from "../trajectory/atif-store.js";
import { createFsAtifDelegate } from "../trajectory/fs-delegate.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const E2E = process.env.E2E_TESTS === "1";
const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = "google/gemini-2.0-flash-001";

const describeE2E = E2E && API_KEY ? describe : describe.skip;

const trajDirs: string[] = [];

afterEach(() => {
  for (const dir of trajDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  trajDirs.length = 0;
});

// ---------------------------------------------------------------------------
// Tool: add_numbers
// ---------------------------------------------------------------------------

const ADD_DESCRIPTOR: ToolDescriptor = {
  name: "add_numbers",
  description: "Add two numbers together and return the sum",
  inputSchema: {
    type: "object",
    properties: {
      a: { type: "number", description: "First number" },
      b: { type: "number", description: "Second number" },
    },
    required: ["a", "b"],
  },
};

const addTool: Tool = {
  descriptor: ADD_DESCRIPTOR,
  origin: "primordial",
  policy: DEFAULT_UNSANDBOXED_POLICY,
  execute: async (args: JsonObject): Promise<unknown> => {
    const a = args.a as number;
    const b = args.b as number;
    return { result: a + b };
  },
};

// ---------------------------------------------------------------------------
// Engine adapter: bridges model adapter into the engine's stream contract.
// The engine calls adapter.stream(input) where input has callHandlers
// composed with middleware. The adapter uses callHandlers to make model
// calls through the middleware chain.
// ---------------------------------------------------------------------------

/**
 * Bridge adapter: minimal agent loop (model → tool → model).
 * Exposes terminals for middleware composition. The stream() method
 * implements the tool-use loop using callHandlers.
 */
function createBridgeAdapter(
  modelComplete: ReturnType<typeof createOpenAICompatAdapter>["complete"],
  modelStreamFn: ReturnType<typeof createOpenAICompatAdapter>["stream"],
): EngineAdapter {
  return {
    engineId: "bridge",
    capabilities: { text: true, images: false, files: false, audio: false },
    terminals: {
      modelCall: modelComplete,
      modelStream: modelStreamFn,
    },
    stream(input: EngineInput): AsyncIterable<EngineEvent> {
      const handlers = input.callHandlers;
      if (handlers === undefined) {
        return (async function* () {
          yield {
            kind: "done" as const,
            output: {
              content: [],
              stopReason: "error" as const,
              metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
              metadata: { error: "No callHandlers — adapter requires cooperating mode" },
            },
          };
        })();
      }

      const initialText = input.kind === "text" ? input.text : "";
      const initialMessages: {
        readonly senderId: string;
        readonly timestamp: number;
        readonly content: readonly { readonly kind: "text"; readonly text: string }[];
      }[] = [
        {
          senderId: "user",
          timestamp: Date.now(),
          content: [{ kind: "text" as const, text: initialText }],
        },
      ];

      return (async function* () {
        // let: mutable conversation state across turns
        let messages = [...initialMessages];
        // let: mutable turn counter
        let turnIndex = 0;

        const MAX_TURNS = 2;

        while (turnIndex < MAX_TURNS) {
          // Model call through middleware chain — collect events
          const turnEvents: EngineEvent[] = [];
          // let: mutable — the done event to yield at the end
          let doneEvent: EngineEvent | undefined;

          for await (const event of consumeModelStream(
            handlers.modelStream
              ? handlers.modelStream({ messages, model: MODEL })
              : (async function* (): AsyncIterable<ModelChunk> {
                  const resp = await handlers.modelCall({ messages, model: MODEL });
                  yield {
                    kind: "done" as const,
                    response: { content: resp.content, model: MODEL },
                  };
                })(),
            input.signal,
          )) {
            if (event.kind === "done") {
              doneEvent = event;
            } else {
              turnEvents.push(event);
              yield event;
            }
          }

          // Check if model requested tool calls
          const toolCalls = turnEvents.filter((e) => e.kind === "tool_call_end");

          if (toolCalls.length === 0) {
            // No tool calls — yield done and exit
            if (doneEvent !== undefined) yield doneEvent;
            break;
          }

          // Execute tools and build result messages for next model call
          for (const tc of toolCalls) {
            if (tc.kind !== "tool_call_end") continue;
            const result = tc.result as {
              readonly toolName: string;
              readonly parsedArgs?: JsonObject;
            };
            if (result.parsedArgs === undefined) continue;

            // Execute tool through middleware chain
            yield {
              kind: "tool_call_start" as const,
              toolName: result.toolName,
              callId: `exec-${result.toolName}` as import("@koi/core").ToolCallId,
            };

            const toolResponse = await handlers.toolCall({
              toolId: result.toolName,
              input: result.parsedArgs,
            });

            yield {
              kind: "tool_call_end" as const,
              callId: `exec-${result.toolName}` as import("@koi/core").ToolCallId,
              result: toolResponse.output,
            };

            const outputText =
              typeof toolResponse.output === "string"
                ? toolResponse.output
                : JSON.stringify(toolResponse.output);
            messages = [
              ...messages,
              {
                senderId: "tool" as const,
                timestamp: Date.now(),
                content: [
                  {
                    kind: "text" as const,
                    text: `Tool ${result.toolName} result: ${outputText}`,
                  },
                ],
              },
            ];
          }

          // Remove tools for the follow-up call so the model produces text
          // (otherwise some models loop calling the same tool)
          messages = [
            ...messages,
            {
              senderId: "system" as const,
              timestamp: Date.now(),
              content: [
                {
                  kind: "text" as const,
                  text: "Now respond to the user with the result. Do not use any tools.",
                },
              ],
            },
          ];

          turnIndex++;
        }

        // If we exited the loop without yielding done (hit MAX_TURNS), yield one now
        yield {
          kind: "done" as const,
          output: {
            content: [],
            stopReason: "max_turns" as const,
            metrics: {
              totalTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              turns: turnIndex,
              durationMs: 0,
            },
          },
        };
      })();
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("Full agent loop E2E: model → tool → model", () => {
  test("tool use produces complete ATIF trajectory with model + tool steps", async () => {
    const trajDir = `/tmp/koi-full-loop-${Date.now()}`;
    trajDirs.push(trajDir);

    const store = createAtifDocumentStore(
      { agentName: "full-loop" },
      createFsAtifDelegate(trajDir),
    );
    const docId = "full-loop";

    const { middleware: eventTrace } = createEventTraceMiddleware({
      store,
      docId,
      agentName: "full-loop",
    });

    const modelAdapter = createOpenAICompatAdapter({
      apiKey: API_KEY ?? "",
      baseUrl: "https://openrouter.ai/api/v1",
      model: MODEL,
      retry: { maxRetries: 1 },
    });

    const adapter = createBridgeAdapter(modelAdapter.complete, modelAdapter.stream);

    const runtime = await createKoi({
      manifest: {
        name: "full-loop-agent",
        version: "0.1.0",
        model: { name: MODEL },
      },
      adapter,
      middleware: [eventTrace],
      providers: [
        createSingleToolProvider({
          name: "add-numbers",
          toolName: "add_numbers",
          createTool: () => addTool,
        }),
      ],
      loopDetection: false,
    });

    // Run the full agent loop
    const events: EngineEvent[] = [];
    for await (const event of runtime.run({
      kind: "text",
      text: "Use the add_numbers tool to compute 7 + 5. After getting the result, respond with just the number.",
    })) {
      events.push(event);
    }

    // -----------------------------------------------------------------------
    // Verify event sequence: should have turns, tool calls, and done
    // -----------------------------------------------------------------------
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("turn_start");
    expect(kinds).toContain("done");

    // Tool call should be present
    const toolStart = events.find((e) => e.kind === "tool_call_start");
    expect(toolStart).toBeDefined();
    if (toolStart?.kind === "tool_call_start") {
      expect(toolStart.toolName).toBe("add_numbers");
    }

    const toolEnd = events.find((e) => e.kind === "tool_call_end");
    expect(toolEnd).toBeDefined();

    // Done event present (completed or max_turns)
    const done = events.find((e) => e.kind === "done");
    expect(done?.kind).toBe("done");

    // -----------------------------------------------------------------------
    // Verify ATIF trajectory
    // The engine calls onAfterTurn + onSessionEnd which flushes event-trace.
    // -----------------------------------------------------------------------
    // The engine's onSessionEnd fires in the generator's finally block.
    // After the for-await completes, the generator cleanup runs async.
    // Dispose triggers session end hooks explicitly.
    await runtime.dispose();
    await new Promise((r) => setTimeout(r, 200));

    const steps = await store.getDocument(docId);

    const modelSteps = steps.filter((s) => s.kind === "model_call");
    const toolSteps = steps.filter((s) => s.kind === "tool_call");

    // MUST have both model and tool call steps
    expect(modelSteps.length).toBeGreaterThan(0);
    expect(toolSteps.length).toBeGreaterThan(0);

    // Tool step should be add_numbers with success
    expect(toolSteps[0]?.identifier).toBe("add_numbers");
    expect(toolSteps[0]?.outcome).toBe("success");
    expect(toolSteps[0]?.durationMs).toBeGreaterThanOrEqual(0);

    // Model step should have timing
    expect(modelSteps[0]?.durationMs).toBeGreaterThan(0);

    // ATIF files on disk
    const files = await readdir(trajDir);
    expect(files.filter((f) => f.endsWith(".atif.json")).length).toBeGreaterThan(0);

    // Print trajectory
    console.log(`\n=== Full Loop ATIF (${steps.length} steps) ===`);
    for (const s of steps) {
      console.log(`  [${s.kind}] ${s.identifier} (${s.durationMs.toFixed(0)}ms) ${s.outcome}`);
      if (s.request?.text) console.log(`        in:  ${s.request.text.slice(0, 120)}`);
      if (s.response?.text) console.log(`        out: ${s.response.text.slice(0, 120)}`);
    }
  }, 30000);
});
