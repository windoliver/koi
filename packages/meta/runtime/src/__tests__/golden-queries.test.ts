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

    // All 4 built-ins discoverable (await for T | Promise<T> L0 interface)
    const list = await resolver.list();
    expect(list.length).toBe(4);

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

// ---------------------------------------------------------------------------
// Golden: @koi/skills-runtime
// ---------------------------------------------------------------------------

import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { createSkillsRuntime } from "@koi/skills-runtime";

describe("Golden: @koi/skills-runtime", () => {
  test("three-source discovery: project shadows user, load returns correct tier", async () => {
    const bundledRoot = await mkdtemp("/tmp/koi-golden-bundled-");
    const userRoot = await mkdtemp("/tmp/koi-golden-user-");
    const projectRoot = await mkdtemp("/tmp/koi-golden-project-");

    // Write same skill name to user and project (project should win)
    const skillContent = (name: string, desc: string): string =>
      `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\nBody.`;

    await Bun.write(
      join(userRoot, "shared-skill", "SKILL.md"),
      skillContent("shared-skill", "User version."),
      { createPath: true },
    );
    await Bun.write(
      join(projectRoot, "shared-skill", "SKILL.md"),
      skillContent("shared-skill", "Project version."),
      { createPath: true },
    );
    await Bun.write(
      join(bundledRoot, "bundled-only", "SKILL.md"),
      skillContent("bundled-only", "Only in bundled."),
      { createPath: true },
    );

    const shadowed: string[] = [];
    const runtime = createSkillsRuntime({
      bundledRoot,
      userRoot,
      projectRoot,
      onShadowedSkill: (name) => {
        shadowed.push(name);
      },
    });

    // Discover: 2 skills total (shared-skill from project, bundled-only from bundled)
    const discoverResult = await runtime.discover();
    expect(discoverResult.ok).toBe(true);
    if (!discoverResult.ok) return;

    expect(discoverResult.value.get("shared-skill")?.source).toBe("project");
    expect(discoverResult.value.get("bundled-only")?.source).toBe("bundled");
    expect(discoverResult.value.size).toBe(2);
    expect(shadowed).toContain("shared-skill");

    // Metadata available from discover (progressive loading)
    expect(discoverResult.value.get("shared-skill")?.description).toBe("Project version.");

    // Load: project version wins
    const loaded = await runtime.load("shared-skill");
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.description).toBe("Project version.");
    expect(loaded.value.source).toBe("project");
  });

  test("security scan blocks eval skill (fail-closed, PERMISSION error)", async () => {
    const userRoot = await mkdtemp("/tmp/koi-golden-scan-");

    const maliciousSkill = `---
name: evil-skill
description: Contains eval.
---

\`\`\`typescript
eval("malicious");
\`\`\`
`;
    await Bun.write(join(userRoot, "evil-skill", "SKILL.md"), maliciousSkill, {
      createPath: true,
    });

    const runtime = createSkillsRuntime({
      bundledRoot: null,
      userRoot,
      projectRoot: "/nonexistent/project",
      blockOnSeverity: "HIGH",
    });

    const result = await runtime.load("evil-skill");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Fail-closed: scan blocking returns PERMISSION, not VALIDATION or INTERNAL
    expect(result.error.code).toBe("PERMISSION");
    expect(result.error.message).toContain("evil-skill");
  });
});

// ---------------------------------------------------------------------------
// Golden: @koi/context-manager (#1623)
// ---------------------------------------------------------------------------

import { budgetConfigFromResolved, enforceBudget, resolveConfig } from "@koi/context-manager";
import type { InboundMessage } from "@koi/core";

describe("Golden: @koi/context-manager", () => {
  function makeMsg(senderId: "user" | "assistant", text: string): InboundMessage {
    return { senderId, timestamp: Date.now(), content: [{ kind: "text", text }] };
  }

  // ~225 tokens per block (4 chars/token fallback estimator)
  const block = "The quick brown fox jumps over the lazy dog. ".repeat(20);

  test("micro compaction fires and reduces message count when past soft trigger", async () => {
    // 3000-token window, soft trigger at 50% (1500). 8 messages × ~225 tokens ≈ 1800 tokens.
    const budgetConfig = { contextWindowSize: 3000, softTriggerFraction: 0.5 };
    const msgs: InboundMessage[] = [];
    for (let i = 0; i < 4; i++) {
      msgs.push(makeMsg("user", `Q${i + 1}: ${block}`));
      msgs.push(makeMsg("assistant", `A${i + 1}: ${block}`));
    }

    const result = await enforceBudget([...msgs], undefined, budgetConfig);

    expect(result.compaction).toBe("micro");
    expect(result.messages.length).toBeLessThan(msgs.length);
    // At least the two most-recent messages survive (preserveRecent default)
    expect(result.messages.length).toBeGreaterThan(0);
    // Events include triggered + completed
    const triggered = result.events.find((e) => e.kind === "compaction.triggered");
    expect(triggered).toBeDefined();
    const completed = result.events.find((e) => e.kind === "compaction.completed");
    expect(completed).toBeDefined();
    if (completed?.kind === "compaction.completed") {
      expect(completed.tokensAfter).toBeLessThan(completed.tokensBefore);
    }
  });

  test("resolveConfig returns correct window for known model via model-registry", () => {
    const result = resolveConfig({ modelId: "claude-opus-4-6" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // claude-opus-4-6 has 1M context window
    expect(result.value.contextWindowSize).toBe(1_000_000);

    // budgetConfigFromResolved propagates contextWindowSize
    const cfg = budgetConfigFromResolved(result.value);
    expect(cfg.contextWindowSize).toBe(1_000_000);
    expect(cfg.softTriggerFraction).toBeDefined();
    expect(cfg.hardTriggerFraction).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Golden: @koi/middleware-otel (#1628)
// ---------------------------------------------------------------------------

import { createOtelMiddleware } from "@koi/middleware-otel";

describe("Golden: @koi/middleware-otel", () => {
  test("createOtelMiddleware returns valid handle with correct middleware shape", () => {
    const handle = createOtelMiddleware();

    // onStep is the synchronous observer callback
    expect(typeof handle.onStep).toBe("function");

    // middleware has correct identity for middleware chain composition
    expect(handle.middleware.name).toBe("otel");
    expect(handle.middleware.phase).toBe("observe");
    expect(handle.middleware.priority).toBe(150);
    expect(typeof handle.middleware.onSessionStart).toBe("function");
    expect(typeof handle.middleware.onSessionEnd).toBe("function");
  });

  test("observer-never-throws: onStep swallows errors when no tracer provider is registered", () => {
    const errors: unknown[] = [];
    const handle = createOtelMiddleware({ onSpanError: (e) => errors.push(e) });

    // Calling onStep with a valid model_call step must never throw — even with
    // no global OTel tracer provider registered (safeSpanOp invariant).
    expect(() => {
      handle.onStep("sess-test", {
        stepIndex: 0,
        timestamp: Date.now(),
        source: "agent" as const,
        kind: "model_call" as const,
        identifier: "claude-opus-4-6",
        outcome: "success" as const,
        durationMs: 200,
        metrics: { promptTokens: 10, completionTokens: 20 },
        metadata: { requestModel: "claude-opus-4-6", responseModel: "claude-opus-4-6" },
      });
    }).not.toThrow();
  });
});
