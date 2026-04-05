#!/usr/bin/env bun
/**
 * Demo: createCliHarness wired to createKoi with cassette replay + trajectory.
 *
 * Uses the tool-use cassette (add_numbers 7+5) with event-trace middleware.
 * Shows: harness → KoiRuntime → tool call → trajectory recorded.
 * No API key required.
 *
 * Usage: bun run packages/meta/runtime/scripts/run-harness-demo.ts
 */

import { rmSync } from "node:fs";
import type {
  EngineAdapter,
  EngineEvent,
  EngineInput,
  JsonObject,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  ToolRequest,
} from "@koi/core";
import { createSingleToolProvider } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createEventTraceMiddleware } from "@koi/event-trace";
import { createCliHarness } from "@koi/harness";
import { consumeModelStream } from "@koi/query-engine";
import {
  createAtifDocumentStore,
  createFsAtifDelegate,
  createStubChannel,
  loadCassette,
} from "@koi/runtime";
import { buildTool } from "@koi/tools-core";

const FIXTURES = `${import.meta.dirname}/../fixtures`;
const TRAJ_DIR = `/tmp/harness-demo-${Date.now()}`;
const MODEL = "google/gemini-2.0-flash-001";

// ── Tool ──────────────────────────────────────────────────────────────────
const addToolResult = buildTool({
  name: "add_numbers",
  description: "Add two numbers together",
  inputSchema: {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  },
  origin: "primordial",
  execute: async (args: JsonObject) => ({ result: (args.a as number) + (args.b as number) }),
});
if (!addToolResult.ok) {
  console.error(`buildTool failed: ${addToolResult.error.message}`);
  process.exit(1);
}
const addTool = addToolResult.value;

// ── Cassette adapter (cooperative — terminals + stream → middleware can intercept) ──
function makeCassetteAdapter(chunks: readonly ModelChunk[]): EngineAdapter {
  // let: mutable call counter
  let callCount = 0;
  return {
    engineId: "cassette",
    capabilities: { text: true, images: false, files: false, audio: false },
    terminals: {
      modelCall: async (_req: ModelRequest): Promise<ModelResponse> => ({
        content: "fallback",
        model: MODEL,
      }),
      modelStream: (_req: ModelRequest): AsyncIterable<ModelChunk> => {
        const n = callCount++;
        if (n === 0)
          return (async function* () {
            yield* chunks;
          })();
        // Second call (after tool result) — simple text completion
        return (async function* (): AsyncIterable<ModelChunk> {
          yield { kind: "text_delta" as const, delta: "The result is 12." };
          yield {
            kind: "done" as const,
            response: {
              content: "The result is 12.",
              model: MODEL,
              usage: { inputTokens: 15, outputTokens: 5 },
            },
          };
        })();
      },
      toolCall: async (req: ToolRequest) => {
        const output = await addTool.execute(req.input as { a: number; b: number });
        return { output };
      },
    },
    stream(input: EngineInput): AsyncIterable<EngineEvent> {
      const h = input.callHandlers;
      if (!h) throw new Error("No callHandlers — createKoi must compose terminals first");

      const userText = input.kind === "text" ? input.text : "";
      const msgs: {
        senderId: string;
        timestamp: number;
        content: { kind: "text"; text: string }[];
        metadata?: JsonObject;
      }[] = [
        { senderId: "user", timestamp: Date.now(), content: [{ kind: "text", text: userText }] },
      ];

      return (async function* (): AsyncIterable<EngineEvent> {
        // let: mutable turn counter
        let turn = 0;
        while (turn < 3) {
          turn++;
          const eventsThisTurn: EngineEvent[] = [];
          // let: mutable done event
          let doneEvent: EngineEvent | undefined;

          const stream = h.modelStream
            ? h.modelStream({ messages: msgs, model: MODEL })
            : (async function* (): AsyncIterable<ModelChunk> {
                const r = await h.modelCall({ messages: msgs, model: MODEL });
                yield { kind: "done" as const, response: { content: r.content, model: MODEL } };
              })();

          for await (const e of consumeModelStream(stream, input.signal)) {
            if (e.kind === "done") {
              doneEvent = e;
            } else {
              eventsThisTurn.push(e);
              yield e;
            }
          }

          // Collect tool call ends and execute them
          const toolEnds = eventsThisTurn.filter((e) => e.kind === "tool_call_end");
          if (toolEnds.length === 0) {
            if (doneEvent) yield doneEvent;
            break;
          }

          // Execute tools and add results to message history
          for (const tc of toolEnds) {
            if (tc.kind !== "tool_call_end") continue;
            const r = tc.result as { toolName: string; parsedArgs?: JsonObject };
            if (!r.parsedArgs) continue;
            const resp = await h.toolCall({
              toolId: r.toolName,
              input: r.parsedArgs,
              callId: tc.callId,
            });
            const out = typeof resp.output === "string" ? resp.output : JSON.stringify(resp.output);
            msgs.push({
              senderId: "tool",
              timestamp: Date.now(),
              content: [{ kind: "text", text: out }],
            });
          }
        }
      })();
    },
  };
}

// ── Load cassette ─────────────────────────────────────────────────────────
const cassette = await loadCassette(`${FIXTURES}/tool-use.cassette.json`);
console.log(`\n── Cassette: ${cassette.name} (${cassette.chunks.length} chunks) ──`);

// ── Trajectory store ──────────────────────────────────────────────────────
const store = createAtifDocumentStore(
  { agentName: "harness-demo" },
  createFsAtifDelegate(TRAJ_DIR),
);
const docId = "run-1";
const { middleware: eventTrace } = createEventTraceMiddleware({
  store,
  docId,
  agentName: "harness-demo",
});

// ── Runtime ───────────────────────────────────────────────────────────────
const runtime = await createKoi({
  manifest: { name: "harness-demo", version: "0.0.1", model: { name: MODEL } },
  adapter: makeCassetteAdapter(cassette.chunks),
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

// ── Harness ───────────────────────────────────────────────────────────────
const channel = createStubChannel();
const harness = createCliHarness({ runtime, channel, tui: null, verbose: true });

console.log("\nPrompt : 'Use add_numbers to compute 7 + 5'");
console.log("── streamed output (verbose) ──");

const result = await harness.runSinglePrompt("Use the add_numbers tool to compute 7 + 5.");

console.log("\n── EngineOutput ──");
console.log(`stopReason : ${result.stopReason}`);
console.log(`turns      : ${result.metrics.turns}`);
console.log(`tokens     : in=${result.metrics.inputTokens} out=${result.metrics.outputTokens}`);
console.log(`content    : ${JSON.stringify(result.content)}`);

// ── Trajectory ────────────────────────────────────────────────────────────
const steps = await store.getDocument(docId);
console.log(`\n── ATIF trajectory (${steps.length} steps) ──`);
for (const s of steps) {
  const extra =
    "toolName" in s
      ? ` [${(s as { toolName: string }).toolName}]`
      : "model" in s
        ? ` [${(s as { model?: string }).model ?? ""}]`
        : "";
  console.log(`  [${String(s.stepIndex).padStart(2)}] ${s.kind}${extra}`);
}

// Validate key trajectory assertions
const kinds = steps.map((s) => s.kind);
const hasModel = kinds.includes("model_call");
const hasTool = kinds.includes("tool_call");
const hasModelTwice = kinds.filter((k) => k === "model_call").length >= 2;

console.log("\n── Assertions ──");
console.log(`  model_call step       : ${hasModel ? "✅" : "❌"}`);
console.log(`  tool_call step        : ${hasTool ? "✅" : "❌"}`);
console.log(`  model→tool→model flow : ${hasModelTwice && hasTool ? "✅" : "❌"}`);
console.log(`  stopReason=completed  : ${result.stopReason === "completed" ? "✅" : "❌"}`);
console.log(
  `  reply text correct    : ${result.content[0] && "text" in result.content[0] && (result.content[0] as { text: string }).text.includes("12") ? "✅" : "❌"}`,
);

// Cleanup
rmSync(TRAJ_DIR, { recursive: true, force: true });
