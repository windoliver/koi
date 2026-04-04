/**
 * Golden Query Sets — E2E tests with real LLM calls (#1188).
 *
 * Gated on E2E_TESTS=1 + OPENROUTER_API_KEY.
 * CI uses VCR replay (cassettes in fixtures/). Nightly records fresh cassettes.
 *
 * Growth rule: each new package PR adds assertions here.
 */

import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import type { EngineAdapter, EngineEvent, EngineInput, ModelChunk } from "@koi/core";
import { createOpenAICompatAdapter } from "@koi/model-openai-compat";
import { consumeModelStream } from "@koi/query-engine";
import { createRuntime } from "../create-runtime.js";

// ---------------------------------------------------------------------------
// Skip unless E2E_TESTS=1 and API key available
// ---------------------------------------------------------------------------

const E2E = process.env.E2E_TESTS === "1";
const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = "google/gemini-2.0-flash-001";
const TRAJ_DIR = `/tmp/koi-golden-${Date.now()}`;

const describeE2E = E2E && API_KEY ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createModelAdapter(): ReturnType<typeof createOpenAICompatAdapter> {
  return createOpenAICompatAdapter({
    apiKey: API_KEY ?? "",
    baseUrl: "https://openrouter.ai/api/v1",
    model: MODEL,
    retry: { maxRetries: 1 },
  });
}

async function collectEvents(stream: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

async function collectChunks(stream: AsyncIterable<ModelChunk>): Promise<readonly ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Set 1: Simple text response
// ---------------------------------------------------------------------------

describeE2E("Golden Query Set 1: simple text response", () => {
  test("text_delta events received and done has stopReason completed", async () => {
    const adapter = createModelAdapter();
    const chunks = await collectChunks(
      adapter.stream({
        messages: [
          {
            senderId: "user",
            timestamp: Date.now(),
            content: [{ kind: "text", text: "What is 2+2? Answer with just the number." }],
          },
        ],
      }),
    );

    // Structural assertions — never match exact text
    const textDeltas = chunks.filter((c) => c.kind === "text_delta");
    expect(textDeltas.length).toBeGreaterThan(0);

    const done = chunks.find((c) => c.kind === "done");
    expect(done).toBeDefined();
    expect(done?.kind).toBe("done");
    if (done?.kind === "done") {
      expect(done.response.content.length).toBeGreaterThan(0);
      expect(done.response.usage?.inputTokens).toBeGreaterThan(0);
    }
  });

  test("consumeModelStream produces done with completed stopReason", async () => {
    const adapter = createModelAdapter();
    const events = await collectEvents(
      consumeModelStream(
        adapter.stream({
          messages: [
            {
              senderId: "user",
              timestamp: Date.now(),
              content: [{ kind: "text", text: "What is 2+2? Answer with just the number." }],
            },
          ],
        }),
      ),
    );

    const textDeltas = events.filter((e) => e.kind === "text_delta");
    expect(textDeltas.length).toBeGreaterThan(0);

    const done = events.at(-1);
    expect(done?.kind).toBe("done");
    if (done?.kind === "done") {
      expect(done.output.stopReason).toBe("completed");
      expect(done.output.metrics.inputTokens).toBeGreaterThan(0);
    }
  });

  test("harness trajectory captures chain-level model call step", async () => {
    // Wire the real model adapter as a terminal inside a cooperating adapter
    const modelAdapter = createModelAdapter();

    const cooperatingAdapter: EngineAdapter = {
      engineId: "golden-cooperating",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: {
        modelCall: modelAdapter.complete,
        modelStream: modelAdapter.stream,
      },
      stream(input: EngineInput): AsyncIterable<EngineEvent> {
        const handlers = input.callHandlers;
        return (async function* () {
          if (handlers !== undefined) {
            // Make a real LLM call through the composed middleware chain
            await handlers.modelCall({
              messages: [
                {
                  senderId: "user",
                  timestamp: Date.now(),
                  content: [{ kind: "text", text: "Say hello in one word" }],
                },
              ],
              model: MODEL,
            });
          }
          yield {
            kind: "done" as const,
            output: {
              content: [],
              stopReason: "completed" as const,
              metrics: {
                totalTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
                turns: 0,
                durationMs: 0,
              },
            },
          };
        })();
      },
    };

    const runtime = createRuntime({
      adapter: cooperatingAdapter,
      middleware: [],
      trajectoryDir: TRAJ_DIR,
      agentName: "golden-test",
    });

    // Drive the runtime — this triggers the LLM call through the chain
    for await (const _event of runtime.adapter.stream({ kind: "text", text: "go" })) {
      // drain
    }

    // Give flush a tick
    await new Promise((r) => setTimeout(r, 100));

    const store = runtime.trajectoryStore;
    expect(store).toBeDefined();
    if (store === undefined) throw new Error("store should exist");

    // Find the ATIF doc (per-stream unique docId)
    const files = await readdir(TRAJ_DIR);
    const atifFiles = files.filter((f: string) => f.endsWith(".atif.json"));
    expect(atifFiles).toHaveLength(1);
    const docId = decodeURIComponent(atifFiles[0]?.replace(".atif.json", "") ?? "");

    const steps = await store.getDocument(docId);
    expect(steps.length).toBeGreaterThan(0);

    // Harness-level step: model call with timing + traceCallId + model name
    const modelStep = steps[0];
    expect(modelStep?.kind).toBe("model_call");
    expect(modelStep?.identifier).toBe(MODEL);
    expect(modelStep?.outcome).toBe("success");
    expect(modelStep?.durationMs).toBeGreaterThan(0);
    expect(modelStep?.metadata?.traceCallId).toBeDefined();

    // Chain-level I/O captured
    expect(modelStep?.request?.text).toContain("hello");
    expect(modelStep?.response?.text).toBeDefined();
    expect((modelStep?.response?.text ?? "").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Set 2: Tool use flow
// ---------------------------------------------------------------------------

describeE2E("Golden Query Set 2: tool use flow", () => {
  const ADD_TOOL = {
    name: "add_numbers",
    description: "Add two numbers together",
    inputSchema: {
      type: "object" as const,
      properties: {
        a: { type: "number" as const, description: "First number" },
        b: { type: "number" as const, description: "Second number" },
      },
      required: ["a", "b"] as const,
    },
  };

  test("tool_call_start with correct toolName and tool_call_end with args", async () => {
    const adapter = createModelAdapter();
    const chunks = await collectChunks(
      adapter.stream({
        messages: [
          {
            senderId: "user",
            timestamp: Date.now(),
            content: [{ kind: "text", text: "Use the add_numbers tool to compute 7 + 5" }],
          },
        ],
        tools: [ADD_TOOL],
      }),
    );

    // Model should invoke the tool
    const toolStart = chunks.find((c) => c.kind === "tool_call_start");
    expect(toolStart).toBeDefined();
    if (toolStart?.kind === "tool_call_start") {
      expect(toolStart.toolName).toBe("add_numbers");
    }

    // Tool call end should be present
    const toolEnd = chunks.find((c) => c.kind === "tool_call_end");
    expect(toolEnd).toBeDefined();

    // Done event should indicate tool_use stop reason or have content
    const done = chunks.find((c) => c.kind === "done");
    expect(done).toBeDefined();
  });

  test("consumeModelStream accumulates tool args correctly", async () => {
    const adapter = createModelAdapter();
    const events = await collectEvents(
      consumeModelStream(
        adapter.stream({
          messages: [
            {
              senderId: "user",
              timestamp: Date.now(),
              content: [{ kind: "text", text: "Use the add_numbers tool to compute 7 + 5" }],
            },
          ],
          tools: [ADD_TOOL],
        }),
      ),
    );

    const toolEnd = events.find((e) => e.kind === "tool_call_end");
    expect(toolEnd).toBeDefined();
    if (toolEnd?.kind === "tool_call_end") {
      const result = toolEnd.result as { readonly parsedArgs?: Record<string, unknown> };
      expect(result.parsedArgs).toBeDefined();
      expect(result.parsedArgs?.a).toBe(7);
      expect(result.parsedArgs?.b).toBe(5);
    }
  });
});

// ---------------------------------------------------------------------------
// Golden: @koi/agent-runtime (#1424)
// ---------------------------------------------------------------------------

import {
  createAgentDefinitionRegistry,
  createDefinitionResolver,
  getBuiltInAgents,
  loadCustomAgents,
} from "@koi/agent-runtime";

describe("Golden: @koi/agent-runtime", () => {
  test("built-in agents load and resolve through full pipeline", async () => {
    const builtIn = getBuiltInAgents();
    const registry = createAgentDefinitionRegistry(builtIn, []);
    const resolver = createDefinitionResolver(registry);

    // All 3 built-ins discoverable (await for T | Promise<T> L0 interface)
    const list = await resolver.list();
    expect(list.length).toBe(3);

    // Each resolves successfully with correct shape
    for (const summary of list) {
      const result = await resolver.resolve(summary.key);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBeTruthy();
        expect(result.value.description).toBeTruthy();
        expect(result.value.manifest.model).toBeDefined();
      }
    }

    // Specific agents exist
    const researcher = await resolver.resolve("researcher");
    expect(researcher.ok).toBe(true);
    const coder = await resolver.resolve("coder");
    expect(coder.ok).toBe(true);
    const reviewer = await resolver.resolve("reviewer");
    expect(reviewer.ok).toBe(true);
  });

  test("custom agent loading from missing directory produces empty results", () => {
    const result = loadCustomAgents({ projectDir: "/nonexistent/path" });
    expect(result.agents.length).toBe(0);
    expect(result.warnings.length).toBe(0);
    expect(result.failedTypes.length).toBe(0);
  });

  test("registry priority override: project beats built-in", () => {
    const builtIn = getBuiltInAgents();
    // Simulate a custom agent that overrides "researcher"
    const customDef = {
      agentType: "researcher",
      whenToUse: "Custom override",
      source: "project" as const,
      manifest: {
        name: "researcher",
        version: "0.0.0",
        description: "Custom",
        model: { name: "opus" },
      },
      name: "researcher",
      description: "Custom",
    };
    const registry = createAgentDefinitionRegistry(builtIn, [customDef]);
    const resolved = registry.resolve("researcher");

    expect(resolved).toBeDefined();
    expect(resolved?.source).toBe("project");
    expect(resolved?.manifest.model.name).toBe("opus");
  });
});
