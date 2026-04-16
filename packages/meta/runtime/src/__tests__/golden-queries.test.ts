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
// Golden: @koi/middleware-audit (2 queries)
// ---------------------------------------------------------------------------

import { createAuditMiddleware } from "@koi/middleware-audit";

describe("Golden: @koi/middleware-audit", () => {
  test("middleware name is 'audit' with phase 'observe' and priority 300", async () => {
    const mw = createAuditMiddleware({
      sink: {
        log: async (): Promise<void> => {},
      },
    });
    expect(mw.name).toBe("audit");
    expect(mw.phase).toBe("observe");
    expect(mw.priority).toBe(300);
  });

  test("entries are flushed after onSessionEnd", async () => {
    const entries: unknown[] = [];
    const mw = createAuditMiddleware({
      sink: {
        log: async (entry): Promise<void> => {
          entries.push(entry);
        },
      },
    });
    await mw.onSessionStart?.({
      agentId: "test-agent",
      sessionId: "test-session" as never,
      runId: "test-run" as never,
      metadata: {},
    });
    await mw.onSessionEnd?.({
      agentId: "test-agent",
      sessionId: "test-session" as never,
      runId: "test-run" as never,
      metadata: {},
    });
    // onSessionEnd flushes — both session_start and session_end must be logged
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const kinds = (entries as { readonly kind?: string }[]).map((e) => e.kind);
    expect(kinds).toContain("session_start");
    expect(kinds).toContain("session_end");
  });
});

// ---------------------------------------------------------------------------
// Golden: @koi/audit-sink-sqlite (2 queries)
// ---------------------------------------------------------------------------

import { createSqliteAuditSink } from "@koi/audit-sink-sqlite";

describe("Golden: @koi/audit-sink-sqlite", () => {
  test("in-memory sink accepts entries and returns them after flush", async () => {
    const sink = createSqliteAuditSink({ dbPath: ":memory:" });
    await sink.log({
      schema_version: 1,
      timestamp: Date.now(),
      sessionId: "golden-session",
      agentId: "golden-agent",
      turnIndex: 0,
      kind: "model_call",
      durationMs: 5,
    });
    await sink.flush();
    const entries = sink.getEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]?.kind).toBe("model_call");
    sink.close();
  });

  test("query() filters by sessionId with WAL mode active", async () => {
    const sink = createSqliteAuditSink({ dbPath: ":memory:" });
    await sink.log({
      schema_version: 1,
      timestamp: Date.now(),
      sessionId: "session-A",
      agentId: "agent",
      turnIndex: 0,
      kind: "session_start",
      durationMs: 0,
    });
    await sink.log({
      schema_version: 1,
      timestamp: Date.now(),
      sessionId: "session-B",
      agentId: "agent",
      turnIndex: 0,
      kind: "session_start",
      durationMs: 0,
    });
    await sink.flush();
    const results = await sink.query?.("session-A");
    expect(results).toHaveLength(1);
    expect(results?.[0]?.sessionId).toBe("session-A");
    sink.close();
  });
});

// ---------------------------------------------------------------------------
// Golden: @koi/audit-sink-ndjson (2 queries)
// ---------------------------------------------------------------------------

import { mkdtemp as mkdtempNdjson, rm as rmNdjson } from "node:fs/promises";
import { join as joinNdjson } from "node:path";
import { createNdjsonAuditSink } from "@koi/audit-sink-ndjson";

describe("Golden: @koi/audit-sink-ndjson", () => {
  test("writes entries as NDJSON lines and reads them back", async () => {
    const tmpDir = await mkdtempNdjson("/tmp/koi-golden-ndjson-");
    const filePath = joinNdjson(tmpDir, "audit.ndjson");
    const sink = createNdjsonAuditSink({ filePath });
    await sink.log({
      schema_version: 1,
      timestamp: Date.now(),
      sessionId: "ndjson-session",
      agentId: "ndjson-agent",
      turnIndex: 0,
      kind: "model_call",
      durationMs: 3,
    });
    await sink.flush();
    const entries = await sink.getEntries();
    expect(entries.length).toBe(1);
    expect(entries[0]?.sessionId).toBe("ndjson-session");
    await sink.close();
    await rmNdjson(tmpDir, { recursive: true, force: true });
  });

  test("schema_version is preserved in round-trip serialization", async () => {
    const tmpDir = await mkdtempNdjson("/tmp/koi-golden-ndjson-sv-");
    const filePath = joinNdjson(tmpDir, "audit.ndjson");
    const sink = createNdjsonAuditSink({ filePath });
    await sink.log({
      schema_version: 1,
      timestamp: Date.now(),
      sessionId: "sv-session",
      agentId: "sv-agent",
      turnIndex: -1,
      kind: "session_start",
      durationMs: 0,
    });
    await sink.flush();
    const entries = await sink.getEntries();
    expect(entries[0]?.schema_version).toBe(1);
    await sink.close();
    await rmNdjson(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Golden: @koi/context-manager (#1623)
// ---------------------------------------------------------------------------

import { budgetConfigFromResolved, enforceBudget, resolveConfig } from "@koi/context-manager";
import type { InboundMessage, ModelRequest, ModelResponse } from "@koi/core";

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
// Golden: @koi/model-router (#1626)
// ---------------------------------------------------------------------------

import {
  createModelRouter,
  createModelRouterMiddleware,
  validateRouterConfig,
} from "@koi/model-router";

describe("Golden: @koi/model-router", () => {
  function makeRequest(text = "hello"): ModelRequest {
    return {
      messages: [{ senderId: "user", content: [{ kind: "text", text }], timestamp: 0 }],
      model: "placeholder",
    };
  }

  function makeResponse(model: string): ModelResponse {
    return { content: `from ${model}`, model, usage: { inputTokens: 5, outputTokens: 10 } };
  }

  test("fallback routing: primary fails → secondary serves request", async () => {
    const configResult = validateRouterConfig({
      strategy: "fallback",
      targets: [
        { provider: "primary", model: "fast", adapterConfig: {} },
        { provider: "backup", model: "safe", adapterConfig: {} },
      ],
      retry: { maxRetries: 0 },
    });
    expect(configResult.ok).toBe(true);
    if (!configResult.ok) return;

    const adapters = new Map([
      [
        "primary",
        {
          id: "primary",
          async complete(): Promise<ModelResponse> {
            throw new Error("primary-down");
          },
          stream(): AsyncGenerator<ModelChunk> {
            throw new Error("primary-down");
          },
        },
      ],
      [
        "backup",
        {
          id: "backup",
          async complete(): Promise<ModelResponse> {
            return makeResponse("safe");
          },
          async *stream(): AsyncGenerator<ModelChunk> {
            yield { kind: "text_delta", delta: "from-backup" };
          },
        },
      ],
    ]);

    const router = createModelRouter(configResult.value, adapters);
    const result = await router.route(makeRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.response.model).toBe("safe");
    expect(result.value.decision.fallbackOccurred).toBe(true);
    expect(result.value.decision.selectedTargetId).toBe("backup:safe");
    expect(result.value.decision.attemptedTargetIds).toEqual(["primary:fast", "backup:safe"]);

    const metrics = router.getMetrics();
    expect(metrics.totalRequests).toBe(1);
    expect(metrics.byTarget.get("primary:fast")?.failures).toBe(1);
    expect(metrics.byTarget.get("backup:safe")?.requests).toBe(1);

    const health = router.getHealth();
    expect(health.get("primary:fast")?.state).toBe("CLOSED");
    expect(health.get("backup:safe")?.state).toBe("CLOSED");
    router.dispose();
  });

  test("middleware reports fallback_occurred:true via ctx.reportDecision when primary fails", async () => {
    const configResult = validateRouterConfig({
      strategy: "fallback",
      targets: [
        { provider: "primary", model: "fast", adapterConfig: {} },
        { provider: "backup", model: "safe", adapterConfig: {} },
      ],
      retry: { maxRetries: 0 },
    });
    expect(configResult.ok).toBe(true);
    if (!configResult.ok) return;

    const adapters = new Map([
      [
        "primary",
        {
          id: "primary",
          async complete(): Promise<ModelResponse> {
            throw new Error("primary-down");
          },
          stream(): AsyncGenerator<ModelChunk> {
            throw new Error("primary-down");
          },
        },
      ],
      [
        "backup",
        {
          id: "backup",
          async complete(): Promise<ModelResponse> {
            return makeResponse("safe");
          },
          async *stream(): AsyncGenerator<ModelChunk> {
            yield { kind: "text_delta", delta: "from-backup" };
          },
        },
      ],
    ]);

    const router = createModelRouter(configResult.value, adapters);
    const mw = createModelRouterMiddleware(router);

    // Capture decisions emitted via ctx.reportDecision — this is what lands in ATIF
    const reported: Record<string, unknown>[] = [];
    const ctx = {
      reportDecision: (d: Record<string, unknown>) => {
        reported.push(d);
      },
    } as unknown as import("@koi/core").TurnContext;

    // wrapModelCall: middleware should route, fallback, then report decisions
    if (mw.wrapModelCall === undefined) throw new Error("wrapModelCall not defined");
    const response = await mw.wrapModelCall(ctx, makeRequest(), async () => {
      throw new Error("should not reach next — router handles it");
    });

    expect(response.model).toBe("safe");

    // ATIF observability: router.fallback_occurred must be true in reported decisions
    expect(reported).toHaveLength(1);
    expect(reported[0]?.["router.fallback_occurred"]).toBe(true);
    expect(reported[0]?.["router.target.selected"]).toBe("backup:safe");
    expect(reported[0]?.["router.target.attempted"]).toEqual(["primary:fast", "backup:safe"]);
    expect(typeof reported[0]?.["router.latency_ms"]).toBe("number");

    router.dispose();
  });

  test("middleware reports fallback_occurred:true via ctx.reportDecision on stream fallback", async () => {
    const configResult = validateRouterConfig({
      strategy: "fallback",
      targets: [
        { provider: "primary", model: "fast", adapterConfig: {} },
        { provider: "backup", model: "safe", adapterConfig: {} },
      ],
      retry: { maxRetries: 0 },
    });
    expect(configResult.ok).toBe(true);
    if (!configResult.ok) return;

    const adapters = new Map([
      [
        "primary",
        {
          id: "primary",
          async complete(): Promise<ModelResponse> {
            throw new Error("primary-down");
          },
          stream(): AsyncGenerator<ModelChunk> {
            throw new Error("primary-stream-down");
          },
        },
      ],
      [
        "backup",
        {
          id: "backup",
          async complete(): Promise<ModelResponse> {
            return makeResponse("safe");
          },
          async *stream(): AsyncGenerator<ModelChunk> {
            yield { kind: "text_delta", delta: "from-backup" };
          },
        },
      ],
    ]);

    const router = createModelRouter(configResult.value, adapters);
    const mw = createModelRouterMiddleware(router);

    const reported: Record<string, unknown>[] = [];
    const ctx = {
      reportDecision: (d: Record<string, unknown>) => {
        reported.push(d);
      },
    } as unknown as import("@koi/core").TurnContext;

    if (mw.wrapModelStream === undefined) throw new Error("wrapModelStream not defined");
    const chunks: ModelChunk[] = [];
    for await (const chunk of mw.wrapModelStream(ctx, makeRequest(), async function* () {
      yield* [] as ModelChunk[];
    })) {
      chunks.push(chunk);
    }

    expect(
      chunks.some(
        (c) => c.kind === "text_delta" && (c as { delta: string }).delta === "from-backup",
      ),
    ).toBe(true);

    // ATIF observability: fallback must be visible in stream decisions
    expect(reported).toHaveLength(1);
    expect(reported[0]?.["router.fallback_occurred"]).toBe(true);
    expect(reported[0]?.["router.target.selected"]).toBe("backup:safe");
    expect(reported[0]?.["router.target.attempted"]).toEqual(["primary:fast", "backup:safe"]);

    router.dispose();
  });

  test("middleware factory wires router into KoiMiddleware with correct priority", () => {
    const configResult = validateRouterConfig({
      strategy: "fallback",
      targets: [{ provider: "p", model: "m", adapterConfig: {} }],
      retry: { maxRetries: 0 },
    });
    expect(configResult.ok).toBe(true);
    if (!configResult.ok) return;

    const adapters = new Map([
      [
        "p",
        {
          id: "p",
          async complete(): Promise<ModelResponse> {
            return makeResponse("m");
          },
          async *stream(): AsyncGenerator<ModelChunk> {
            yield { kind: "text_delta", delta: "x" };
          },
        },
      ],
    ]);

    const router = createModelRouter(configResult.value, adapters);
    const mw = createModelRouterMiddleware(router);

    expect(mw.name).toBe("model-router");
    expect(mw.priority).toBe(900);
    expect(typeof mw.wrapModelCall).toBe("function");
    expect(typeof mw.wrapModelStream).toBe("function");
    router.dispose();
  });
});

// ---------------------------------------------------------------------------
// Golden: @koi/middleware-otel (#1628)
// ---------------------------------------------------------------------------

import { createOtelMiddleware } from "@koi/middleware-otel";

// ---------------------------------------------------------------------------
// Golden: @koi/middleware-memory-recall (2 queries)
// ---------------------------------------------------------------------------

import type {
  FileListResult,
  FileReadResult,
  FileSystemBackend,
  KoiError,
  Result,
} from "@koi/core";
import { createMemoryRecallMiddleware } from "@koi/middleware-memory-recall";

function makeRecallMockFs(
  files: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
    readonly modifiedAt: number;
  }>,
): FileSystemBackend {
  return {
    name: "golden-mock-fs",
    read(path): Result<FileReadResult, KoiError> {
      const file = files.find((f) => f.path === path);
      if (!file)
        return { ok: false, error: { code: "NOT_FOUND", message: "not found", retryable: false } };
      return {
        ok: true,
        value: { content: file.content, path: file.path, size: file.content.length },
      };
    },
    list(path): Result<FileListResult, KoiError> {
      const entries = files
        .filter((f) => f.path.startsWith(path) && f.path.endsWith(".md"))
        .map((f) => ({
          path: f.path,
          kind: "file" as const,
          size: f.content.length,
          modifiedAt: f.modifiedAt,
        }));
      return { ok: true, value: { entries, truncated: false } };
    },
    write() {
      return {
        ok: false,
        error: { code: "INTERNAL" as const, message: "not implemented", retryable: false },
      };
    },
    edit() {
      return {
        ok: false,
        error: { code: "INTERNAL" as const, message: "not implemented", retryable: false },
      };
    },
    search() {
      return {
        ok: false,
        error: { code: "INTERNAL" as const, message: "not implemented", retryable: false },
      };
    },
  };
}

describe("Golden: @koi/middleware-memory-recall", () => {
  test("frozen snapshot: recalls memories once and injects into model calls", async () => {
    const now = Date.now();
    const fs = makeRecallMockFs([
      {
        path: "/mem/role.md",
        content: "---\nname: Role\ndescription: user role\ntype: user\n---\n\nSenior engineer",
        modifiedAt: now,
      },
    ]);
    const mw = createMemoryRecallMiddleware({ fs, recall: { memoryDir: "/mem", now } });

    expect(mw.name).toBe("koi:memory-recall");
    expect(mw.priority).toBe(310);

    let captured: ModelRequest | undefined;
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      captured = req;
      return {
        content: "ok",
        model: "test",
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "stop",
      };
    };
    const ctx = {
      session: { agentId: "a", sessionId: "s" as never, runId: "r" as never, metadata: {} },
      turnIndex: 0,
      turnId: "t" as never,
      messages: [],
      metadata: {},
    };

    await mw.wrapModelCall?.(
      ctx,
      { messages: [{ content: [{ kind: "text", text: "hi" }], senderId: "user", timestamp: now }] },
      next,
    );

    expect(captured).toBeDefined();
    if (captured === undefined) return;
    expect(captured.messages.length).toBe(2);
    expect(captured.messages[0]?.senderId).toBe("system:memory-recall");
    const text = (
      captured.messages[0]?.content[0] as { readonly kind: "text"; readonly text: string }
    )?.text;
    expect(text).toContain("Senior engineer");
  });

  test("graceful degradation: empty dir produces no injection", async () => {
    const fs = makeRecallMockFs([]);
    const mw = createMemoryRecallMiddleware({ fs, recall: { memoryDir: "/mem" } });

    let captured: ModelRequest | undefined;
    const next = async (req: ModelRequest): Promise<ModelResponse> => {
      captured = req;
      return {
        content: "ok",
        model: "test",
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "stop",
      };
    };
    const ctx = {
      session: { agentId: "a", sessionId: "s" as never, runId: "r" as never, metadata: {} },
      turnIndex: 0,
      turnId: "t" as never,
      messages: [],
      metadata: {},
    };

    await mw.wrapModelCall?.(
      ctx,
      {
        messages: [
          { content: [{ kind: "text", text: "hi" }], senderId: "user", timestamp: Date.now() },
        ],
      },
      next,
    );

    if (captured === undefined) return;
    expect(captured.messages.length).toBe(1);
    expect(captured.messages[0]?.senderId).toBe("user");
    expect(mw.describeCapabilities(ctx)).toBeUndefined();
  });
});

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
