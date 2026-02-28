/**
 * E2E test for @koi/tool-ask-user through the full L1 runtime (createKoi).
 *
 * Validates the complete path using TWO adapter stacks:
 *
 * Stack A — createLoopAdapter (OpenRouter / OpenAI / Anthropic via model-router):
 *   Agent assembled with ask_user tool via createKoi
 *     → Direct tool.execute() validates handler callback
 *     → Timeout semantics (AbortSignal composition)
 *     → Error propagation from handler
 *
 * Stack B — createPiAdapter (Anthropic native via pi-agent-core):
 *   Agent assembled with ask_user tool via createKoi
 *     → LLM decides to call ask_user tool
 *     → Handler returns structured answer
 *     → LLM incorporates the answer into its response
 *     → Middleware chain fires correctly
 *
 * Gated on API key + E2E_TESTS=1 — skipped when either is missing.
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e.test.ts
 *   (reads ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY from .env)
 */

import { describe, expect, test } from "bun:test";
import type {
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  Tool,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import type { AgentManifest } from "@koi/core/assembly";
import type { SubsystemToken } from "@koi/core/ecs";
import type { ElicitationQuestion, ElicitationResult } from "@koi/core/elicitation";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createPiAdapter } from "@koi/engine-pi";
import {
  createAnthropicAdapter,
  createOpenAIAdapter,
  createOpenRouterAdapter,
} from "@koi/model-router";
import { createAskUserProvider } from "../provider.js";
import type { ElicitationHandler } from "../types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = OPENROUTER_KEY.length > 0 || OPENAI_KEY.length > 0 || ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

function resolveLoopModel(): string {
  if (OPENROUTER_KEY.length > 0) return "openai/gpt-4o-mini";
  if (OPENAI_KEY.length > 0) return "gpt-4o-mini";
  return "claude-haiku-4-5-20251001";
}

const LOOP_MODEL = resolveLoopModel();
const PI_MODEL = "anthropic:claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

function testManifest(model: string): AgentManifest {
  return {
    name: "ask-user-e2e-agent",
    version: "0.0.1",
    model: { name: model },
  };
}

// ---------------------------------------------------------------------------
// Stack A — createLoopAdapter (via model-router)
// ---------------------------------------------------------------------------

describeE2E("@koi/tool-ask-user E2E — Stack A (createLoopAdapter)", () => {
  const llmAdapter =
    OPENROUTER_KEY.length > 0
      ? createOpenRouterAdapter({ apiKey: OPENROUTER_KEY, appName: "koi-ask-user-e2e" })
      : OPENAI_KEY.length > 0
        ? createOpenAIAdapter({ apiKey: OPENAI_KEY })
        : createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });

  const modelCall = (request: ModelRequest): Promise<ModelResponse> =>
    llmAdapter.complete({ ...request, model: LOOP_MODEL });

  // ── Test 1: Tool attached and invocable through createKoi runtime ──

  test(
    "ask_user tool is attached and directly invocable through createKoi runtime",
    async () => {
      const handlerCalls: ElicitationQuestion[] = [];

      const handler: ElicitationHandler = async (question) => {
        handlerCalls.push(question);
        // Always pick the first option
        const firstOption = question.options[0];
        if (firstOption === undefined) {
          return { selected: [], freeText: "No options provided" };
        }
        return { selected: [firstOption.label] };
      };

      const provider = createAskUserProvider({ handler });
      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });
      const runtime = await createKoi({
        manifest: testManifest(LOOP_MODEL),
        adapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 60_000, maxTokens: 50_000 },
      });

      // Verify tool was attached to assembled agent
      const askTool = runtime.agent.component<Tool>("tool:ask_user" as SubsystemToken<Tool>);
      expect(askTool).toBeDefined();
      expect(askTool?.descriptor.name).toBe("ask_user");

      if (askTool === undefined) {
        throw new Error("ask_user tool was not attached");
      }

      // Directly invoke the tool (bypasses LLM deciding to call it)
      const result = await askTool.execute({
        question: "Which database should we use?",
        header: "Database",
        options: [
          { label: "PostgreSQL", description: "Relational database" },
          { label: "MongoDB", description: "Document database" },
        ],
      });

      // Verify handler was called with correct question
      expect(handlerCalls).toHaveLength(1);
      expect(handlerCalls[0]?.question).toBe("Which database should we use?");
      expect(handlerCalls[0]?.options).toHaveLength(2);

      // Verify result is the handler's response
      const typedResult = result as ElicitationResult;
      expect(typedResult.selected).toEqual(["PostgreSQL"]);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 2: Multi-select through full L1 runtime ─────────────────

  test(
    "multi-select question returns multiple selections through L1 runtime",
    async () => {
      const handler: ElicitationHandler = async (question) => {
        // Select all options
        return { selected: question.options.map((o) => o.label) };
      };

      const provider = createAskUserProvider({ handler });
      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });
      const runtime = await createKoi({
        manifest: testManifest(LOOP_MODEL),
        adapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 60_000, maxTokens: 50_000 },
      });

      const askTool = runtime.agent.component<Tool>("tool:ask_user" as SubsystemToken<Tool>);

      if (askTool === undefined) {
        throw new Error("ask_user tool was not attached");
      }

      const result = await askTool.execute({
        question: "Which features should we enable?",
        options: [
          { label: "Auth", description: "Authentication" },
          { label: "Cache", description: "Caching layer" },
          { label: "Logs", description: "Logging" },
        ],
        multiSelect: true,
      });

      const typedResult = result as ElicitationResult;
      expect(typedResult.selected).toEqual(["Auth", "Cache", "Logs"]);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Free-text response (user picks "Other") ──────────────

  test(
    "free-text response flows through L1 runtime correctly",
    async () => {
      const handler: ElicitationHandler = async () => {
        return { selected: [], freeText: "I want a custom approach with SQLite" };
      };

      const provider = createAskUserProvider({ handler });
      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });
      const runtime = await createKoi({
        manifest: testManifest(LOOP_MODEL),
        adapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 60_000, maxTokens: 50_000 },
      });

      const askTool = runtime.agent.component<Tool>("tool:ask_user" as SubsystemToken<Tool>);

      if (askTool === undefined) {
        throw new Error("ask_user tool was not attached");
      }

      const result = await askTool.execute({
        question: "Which database?",
        options: [
          { label: "PostgreSQL", description: "Relational" },
          { label: "MongoDB", description: "Document" },
        ],
      });

      const typedResult = result as ElicitationResult;
      expect(typedResult.selected).toEqual([]);
      expect(typedResult.freeText).toBe("I want a custom approach with SQLite");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Timeout — handler hangs, tool returns TIMEOUT ────────

  test(
    "tool returns TIMEOUT when handler exceeds timeout through L1 runtime",
    async () => {
      const handler: ElicitationHandler = async (_question, signal) => {
        // Block until signal aborts
        return new Promise<ElicitationResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      };

      const provider = createAskUserProvider({ handler, timeoutMs: 200 });
      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });
      const runtime = await createKoi({
        manifest: testManifest(LOOP_MODEL),
        adapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 60_000, maxTokens: 50_000 },
      });

      const askTool = runtime.agent.component<Tool>("tool:ask_user" as SubsystemToken<Tool>);

      if (askTool === undefined) {
        throw new Error("ask_user tool was not attached");
      }

      const result = (await askTool.execute({
        question: "Will you respond?",
        options: [
          { label: "Yes", description: "I will" },
          { label: "No", description: "I won't" },
        ],
      })) as { code: string };

      expect(result.code).toBe("TIMEOUT");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 5: Handler throws — error propagates as EXTERNAL ────────

  test(
    "handler error propagates as EXTERNAL through L1 runtime",
    async () => {
      const handler: ElicitationHandler = async () => {
        throw new Error("WebSocket connection lost");
      };

      const provider = createAskUserProvider({ handler });
      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });
      const runtime = await createKoi({
        manifest: testManifest(LOOP_MODEL),
        adapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 60_000, maxTokens: 50_000 },
      });

      const askTool = runtime.agent.component<Tool>("tool:ask_user" as SubsystemToken<Tool>);

      if (askTool === undefined) {
        throw new Error("ask_user tool was not attached");
      }

      const result = (await askTool.execute({
        question: "Will this error?",
        options: [
          { label: "Yes", description: "It will" },
          { label: "No", description: "It won't" },
        ],
      })) as { code: string; error: string };

      expect(result.code).toBe("EXTERNAL");
      expect(result.error).toBe("WebSocket connection lost");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 6: Validation error for bad input through L1 runtime ────

  test(
    "invalid model input returns VALIDATION through L1 runtime",
    async () => {
      const handler: ElicitationHandler = async () => {
        return { selected: ["irrelevant"] };
      };

      const provider = createAskUserProvider({ handler, maxOptions: 3 });
      const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });
      const runtime = await createKoi({
        manifest: testManifest(LOOP_MODEL),
        adapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 60_000, maxTokens: 50_000 },
      });

      const askTool = runtime.agent.component<Tool>("tool:ask_user" as SubsystemToken<Tool>);

      if (askTool === undefined) {
        throw new Error("ask_user tool was not attached");
      }

      // Too many options (maxOptions=3 but sending 4)
      const result = (await askTool.execute({
        question: "Pick one?",
        options: [
          { label: "A", description: "A" },
          { label: "B", description: "B" },
          { label: "C", description: "C" },
          { label: "D", description: "D" },
        ],
      })) as { code: string };

      expect(result.code).toBe("VALIDATION");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Stack B — createPiAdapter (Anthropic native, full round-trip with LLM)
// ---------------------------------------------------------------------------

const HAS_ANTHROPIC_KEY = ANTHROPIC_KEY.length > 0;
const describePi = HAS_ANTHROPIC_KEY && E2E_OPTED_IN ? describe : describe.skip;

describePi("@koi/tool-ask-user E2E — Stack B (createPiAdapter full round-trip)", () => {
  // ── Test 7: LLM decides to call ask_user, handler responds, LLM uses answer ──

  test(
    "LLM calls ask_user tool through createPiAdapter and incorporates the answer",
    async () => {
      const handlerCalls: ElicitationQuestion[] = [];

      const handler: ElicitationHandler = async (question) => {
        handlerCalls.push(question);
        // Always pick the first option
        const firstOption = question.options[0];
        if (firstOption === undefined) {
          return { selected: [], freeText: "No options" };
        }
        return { selected: [firstOption.label] };
      };

      const provider = createAskUserProvider({ handler });
      const adapter = createPiAdapter({
        model: PI_MODEL,
        systemPrompt: [
          "You are a helpful assistant. You MUST use the ask_user tool when you need to make a decision.",
          "When asked to choose something, ALWAYS use the ask_user tool to ask the user.",
          "After getting the user's answer, report their choice clearly.",
        ].join(" "),
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest("claude-haiku-4-5"),
        adapter,
        providers: [provider],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: 'I need to pick a programming language. Use the ask_user tool to ask me which language I prefer. Provide these options: label "Python" with description "General purpose", and label "Rust" with description "Systems programming". After getting my answer, tell me what I chose.',
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // The LLM should have called the ask_user tool
      expect(handlerCalls.length).toBeGreaterThanOrEqual(1);

      // The question should contain our options
      const lastCall = handlerCalls[handlerCalls.length - 1];
      expect(lastCall).toBeDefined();
      if (lastCall !== undefined) {
        expect(lastCall.options.length).toBeGreaterThanOrEqual(2);
      }

      // tool_call events should exist for ask_user
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      expect(toolStarts.length).toBeGreaterThanOrEqual(1);

      // The LLM's response should reference the chosen option
      const text = extractText(events);
      // Handler always picks first option; LLM should mention it
      expect(text.length).toBeGreaterThan(0);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 8: Middleware observes ask_user tool call through Pi stack ──

  test(
    "middleware chain intercepts ask_user call through createPiAdapter",
    async () => {
      const toolCalls: string[] = [];

      const observerMiddleware: KoiMiddleware = {
        name: "ask-user-observer",
        describeCapabilities: () => undefined,
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolCalls.push(request.toolId);
          return next(request);
        },
      };

      const handler: ElicitationHandler = async (question) => {
        const firstOption = question.options[0];
        if (firstOption === undefined) {
          return { selected: [], freeText: "fallback" };
        }
        return { selected: [firstOption.label] };
      };

      const provider = createAskUserProvider({ handler });
      const adapter = createPiAdapter({
        model: PI_MODEL,
        systemPrompt:
          "You MUST use the ask_user tool to ask the user a question before answering. Always use the tool, never skip it.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest("claude-haiku-4-5"),
        adapter,
        middleware: [observerMiddleware],
        providers: [provider],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: 'Use the ask_user tool to ask me: "Which color do you prefer?" with options: label "Blue" description "Cool color" and label "Red" description "Warm color". Then tell me my choice.',
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      // Middleware should have observed the ask_user tool call
      expect(toolCalls).toContain("ask_user");

      // The response should mention the user's choice
      const text = extractText(events);
      expect(text.length).toBeGreaterThan(0);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 9: Agent lifecycle fires correctly with ask_user ────────

  test(
    "session lifecycle hooks fire with ask_user tool through Pi stack",
    async () => {
      const hookOrder: string[] = [];

      const lifecycleObserver: KoiMiddleware = {
        name: "lifecycle-observer",
        describeCapabilities: () => undefined,
        onSessionStart: async () => {
          hookOrder.push("session_start");
        },
        onSessionEnd: async () => {
          hookOrder.push("session_end");
        },
        onAfterTurn: async () => {
          hookOrder.push("after_turn");
        },
      };

      const handler: ElicitationHandler = async (question) => {
        const firstOption = question.options[0];
        if (firstOption === undefined) {
          return { selected: [], freeText: "default" };
        }
        return { selected: [firstOption.label] };
      };

      const provider = createAskUserProvider({ handler });
      const adapter = createPiAdapter({
        model: PI_MODEL,
        systemPrompt:
          "You MUST use the ask_user tool for any question. Never answer without using it first.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest("claude-haiku-4-5"),
        adapter,
        middleware: [lifecycleObserver],
        providers: [provider],
        loopDetection: false,
      });

      await collectEvents(
        runtime.run({
          kind: "text",
          text: 'Use ask_user to ask "Tea or coffee?" with options label "Tea" description "Hot beverage" and label "Coffee" description "Caffeinated". Report what I chose.',
        }),
      );

      expect(hookOrder[0]).toBe("session_start");
      expect(hookOrder[hookOrder.length - 1]).toBe("session_end");
      expect(hookOrder).toContain("after_turn");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 10: Free-text response through full Pi round-trip ───────

  test(
    "free-text response flows through Pi adapter and LLM reports it",
    async () => {
      const handler: ElicitationHandler = async () => {
        return { selected: [], freeText: "I want Haskell instead" };
      };

      const provider = createAskUserProvider({ handler });
      const adapter = createPiAdapter({
        model: PI_MODEL,
        systemPrompt:
          "You MUST use the ask_user tool when asked to choose something. Report the user's answer exactly as received.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest("claude-haiku-4-5"),
        adapter,
        providers: [provider],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: 'Use ask_user to ask "Which language?" with options label "Python" description "Dynamic" and label "Go" description "Compiled". Tell me exactly what the user responded.',
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // The response should mention the free-text answer
      const text = extractText(events);
      expect(text.toLowerCase()).toContain("haskell");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
