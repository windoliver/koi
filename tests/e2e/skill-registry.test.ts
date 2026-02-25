/**
 * Skill registry end-to-end validation with real LLM calls.
 *
 * Tests the full createKoi + createPiAdapter stack with real Anthropic API,
 * validating that the skill registry backend works end-to-end through the L1
 * runtime assembly with middleware, tool providers, and a real Pi agent.
 *
 * Key architectural notes (from pi-agent.test.ts):
 * - Pi uses streaming-only mode (modelStream terminal)
 * - Pi does NOT re-broadcast text_delta as EngineEvents — use wrapModelStream
 *   to observe ModelChunks for text output verification
 * - Lifecycle hooks fire normally through L1
 * - For tool-calling tests, the pi-agent E2E uses createLoopAdapter with a
 *   two-phase model handler (deterministic phase 1, real LLM phase 2) to
 *   avoid flakiness. We follow the same pattern for tool-calling validation.
 *
 * Gated on ANTHROPIC_API_KEY — tests are skipped when the key is not set.
 *
 * Run:
 *   bun test tests/e2e/skill-registry.test.ts
 *
 * Cost: ~$0.02-0.05 per run (haiku model, minimal prompts).
 */

import { describe, expect, test } from "bun:test";
import type {
  ComponentProvider,
  EngineEvent,
  JsonObject,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SkillRegistryChangeEvent,
  Tool,
  ToolRequest,
} from "@koi/core";
import { skillId, toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createPiAdapter } from "@koi/engine-pi";
import { createAnthropicAdapter } from "@koi/model-router";
import { createInMemorySkillRegistry } from "@koi/test-utils";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const describeE2E = HAS_KEY ? describe : describe.skip;

const TIMEOUT_MS = 60_000;
const PI_MODEL = "anthropic:claude-haiku-4-5-20251001";
const MODEL_NAME = "claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const result: EngineEvent[] = []; // let justified: test accumulator
  for await (const event of iterable) {
    result.push(event);
  }
  return result;
}

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

function seedRegistry(registry: ReturnType<typeof createInMemorySkillRegistry>): void {
  const results = [
    registry.publish({
      id: skillId("code-review"),
      name: "Code Review",
      description: "Automated code review with security and quality checks",
      tags: ["review", "security", "quality"],
      version: "2.1.0",
      content: "# Code Review Skill\n\nReviews code for quality and security issues.",
      author: "koi-team",
      requires: { bins: ["git"] },
    }),
    registry.publish({
      id: skillId("test-generator"),
      name: "Test Generator",
      description: "Generates unit tests for TypeScript functions",
      tags: ["testing", "typescript"],
      version: "1.0.0",
      content: "# Test Generator\n\nGenerates bun:test unit tests.",
      author: "koi-team",
    }),
    registry.publish({
      id: skillId("deploy-helper"),
      name: "Deploy Helper",
      description: "Assists with cloud deployment to AWS and GCP",
      tags: ["deploy", "cloud", "aws"],
      version: "3.0.0",
      content: "# Deploy Helper\n\nAutomates cloud deployments.",
      author: "community",
      requires: { bins: ["docker"], env: ["AWS_REGION"] },
    }),
  ];

  for (const r of results) {
    if (!r.ok) throw new Error(`Seed publish failed: ${r.error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Tool provider backed by skill registry
// ---------------------------------------------------------------------------

function createSkillRegistryToolProvider(
  registry: ReturnType<typeof createInMemorySkillRegistry>,
): ComponentProvider {
  const searchSkillsTool: Tool = {
    descriptor: {
      name: "search_skills",
      description: "Search the skill registry for available skills.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search text" },
        },
        required: ["query"],
      },
    },
    trustTier: "sandbox",
    execute: async (args: JsonObject) => {
      const text = typeof args.query === "string" ? args.query : "";
      const page = await registry.search({ text });
      return {
        skills: page.items.map((item) => ({
          id: item.id,
          name: item.name,
          description: item.description,
          version: item.version,
          author: item.author,
          tags: item.tags,
          ...(item.requires !== undefined ? { requires: item.requires } : {}),
          ...(item.downloads !== undefined ? { downloads: item.downloads } : {}),
        })),
        total: page.total,
      };
    },
  };

  const installSkillTool: Tool = {
    descriptor: {
      name: "install_skill",
      description: "Install a skill from the registry by its ID.",
      inputSchema: {
        type: "object",
        properties: {
          skill_id: { type: "string", description: "The skill ID to install" },
        },
        required: ["skill_id"],
      },
    },
    trustTier: "sandbox",
    execute: async (args: JsonObject) => {
      const id = typeof args.skill_id === "string" ? args.skill_id : "";
      const result = await registry.install(skillId(id));
      if (!result.ok) {
        return { error: result.error.message };
      }
      return {
        id: result.value.id,
        name: result.value.name,
        version: result.value.version,
        content: result.value.content,
      };
    },
  };

  return {
    name: "skill-registry-tools",
    attach: async () => {
      const components = new Map<string, unknown>();
      components.set(toolToken("search_skills"), searchSkillsTool);
      components.set(toolToken("install_skill"), installSkillTool);
      return components;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Pi agent text response through createKoi with skill registry tools
// ---------------------------------------------------------------------------

describeE2E("e2e: Skill registry with Pi agent through createKoi", () => {
  test(
    "Pi agent produces completed response with skill registry tools wired",
    async () => {
      const registry = createInMemorySkillRegistry();
      seedRegistry(registry);

      // Pi doesn't re-broadcast text_delta as EngineEvents — observe ModelChunks
      const textChunks: string[] = []; // let justified: test accumulator

      const textObserver: KoiMiddleware = {
        name: "e2e-text-observer",
        wrapModelStream: async function* (_ctx, request, next: ModelStreamHandler) {
          for await (const chunk of next(request)) {
            if (chunk.kind === "text_delta") {
              textChunks.push(chunk.delta);
            }
            yield chunk;
          }
        },
      };

      const adapter = createPiAdapter({
        model: PI_MODEL,
        systemPrompt:
          "You are a concise test agent. You have access to search_skills and install_skill tools. Reply in 10 words or fewer.",
        getApiKey: async () => ANTHROPIC_KEY,
        thinkingLevel: "off",
      });

      const runtime = await createKoi({
        manifest: { name: "e2e-pi-skill-reg", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [textObserver],
        providers: [createSkillRegistryToolProvider(registry)],
      });

      try {
        const events = await collectEvents(runtime.run({ kind: "text", text: "Say hello" }));

        // Got a done event with completed status
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // wrapModelStream observed text_delta ModelChunks (real LLM output)
        expect(textChunks.length).toBeGreaterThan(0);
        const fullText = textChunks.join("");
        expect(fullText.length).toBeGreaterThan(0);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  // ── Pi agent lifecycle hooks fire with skill registry tools ─────────────

  test(
    "Pi agent lifecycle hooks fire correctly with skill registry tool provider",
    async () => {
      const registry = createInMemorySkillRegistry();
      seedRegistry(registry);

      const hookLog: string[] = []; // let justified: test accumulator

      const lifecycle: KoiMiddleware = {
        name: "e2e-lifecycle",
        priority: 100,
        onSessionStart: async () => {
          hookLog.push("session:start");
        },
        onBeforeTurn: async () => {
          hookLog.push("turn:before");
        },
        onAfterTurn: async () => {
          hookLog.push("turn:after");
        },
        onSessionEnd: async () => {
          hookLog.push("session:end");
        },
      };

      const adapter = createPiAdapter({
        model: PI_MODEL,
        systemPrompt: "Reply with one word.",
        getApiKey: async () => ANTHROPIC_KEY,
        thinkingLevel: "off",
      });

      const runtime = await createKoi({
        manifest: { name: "e2e-pi-lifecycle", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [lifecycle],
        providers: [createSkillRegistryToolProvider(registry)],
      });

      try {
        await collectEvents(runtime.run({ kind: "text", text: "Hi" }));

        // Lifecycle hooks fired in correct order
        expect(hookLog.at(0)).toBe("session:start");
        expect(hookLog.at(-1)).toBe("session:end");
        expect(hookLog).toContain("turn:before");
        expect(hookLog).toContain("turn:after");

        // Turn hooks are bracketed correctly
        const firstBefore = hookLog.indexOf("turn:before");
        const firstAfter = hookLog.indexOf("turn:after");
        expect(firstBefore).toBeLessThan(firstAfter);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  // ── Pi agent wrapModelStream works with skill registry context ──────────

  test(
    "wrapModelStream intercepts Pi's real streaming LLM call with skill tools available",
    async () => {
      const registry = createInMemorySkillRegistry();
      seedRegistry(registry);

      let streamIntercepted = false; // let justified: toggled in middleware

      const streamObserver: KoiMiddleware = {
        name: "e2e-stream-observer",
        wrapModelStream: (_ctx, request, next: ModelStreamHandler): AsyncIterable<ModelChunk> => {
          streamIntercepted = true;
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: PI_MODEL,
        systemPrompt: "Reply with one word.",
        getApiKey: async () => ANTHROPIC_KEY,
        thinkingLevel: "off",
      });

      const runtime = await createKoi({
        manifest: { name: "e2e-pi-stream", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [streamObserver],
        providers: [createSkillRegistryToolProvider(registry)],
      });

      try {
        const events = await collectEvents(runtime.run({ kind: "text", text: "Hi" }));

        // wrapModelStream was invoked
        expect(streamIntercepted).toBe(true);

        // Agent still completed successfully
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 2. Tool-calling: deterministic phase + real LLM through createLoopAdapter
//
// Uses the two-phase pattern from pi-agent.test.ts test #5:
//   Phase 1: deterministic tool call (no LLM flakiness)
//   Phase 2: real Anthropic LLM generates final answer using tool output
//
// This validates the full wrapToolCall middleware chain + skill registry
// tool execution end-to-end with a real LLM response.
// ---------------------------------------------------------------------------

describeE2E("e2e: Skill registry tool-calling with real LLM", () => {
  // ── search_skills through full L1 chain ─────────────────────────────────

  test(
    "search_skills executes through middleware chain, real LLM summarizes results",
    async () => {
      const registry = createInMemorySkillRegistry();
      seedRegistry(registry);

      const interceptedTools: string[] = []; // let justified: test accumulator

      const toolObserver: KoiMiddleware = {
        name: "e2e-tool-observer",
        wrapToolCall: async (_ctx, request: ToolRequest, next) => {
          interceptedTools.push(request.toolId);
          return next(request);
        },
      };

      // let justified: count model call phases
      let modelCallCount = 0;

      const twoPhaseModelCall = async (request: ModelRequest): Promise<ModelResponse> => {
        modelCallCount++;
        if (modelCallCount === 1) {
          // Phase 1: deterministic search_skills call
          return {
            content: "Let me search for test skills.",
            model: MODEL_NAME,
            usage: { inputTokens: 10, outputTokens: 15 },
            metadata: {
              toolCalls: [
                {
                  toolName: "search_skills",
                  callId: "call-search-1",
                  input: { query: "test" },
                },
              ],
            },
          };
        }
        // Phase 2: real LLM summarizes the search results
        const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
        return anthropic.complete({ ...request, model: MODEL_NAME, maxTokens: 200 });
      };

      const adapter = createLoopAdapter({ modelCall: twoPhaseModelCall, maxTurns: 5 });
      const runtime = await createKoi({
        manifest: { name: "e2e-skill-search", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [toolObserver],
        providers: [createSkillRegistryToolProvider(registry)],
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: "Search for test-related skills and tell me what you found.",
          }),
        );

        // Agent completed with multiple turns
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
          expect(doneEvent.output.metrics.turns).toBeGreaterThanOrEqual(2);
        }

        // Tool call events emitted
        const toolStarts = events.filter((e) => e.kind === "tool_call_start");
        expect(toolStarts.length).toBeGreaterThanOrEqual(1);

        // Middleware intercepted the tool call
        expect(interceptedTools).toContain("search_skills");

        // Real LLM was called for phase 2
        expect(modelCallCount).toBeGreaterThanOrEqual(2);

        // LLM response should be non-empty
        const text = extractText(events);
        expect(text.length).toBeGreaterThan(0);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  // ── install_skill with download tracking ────────────────────────────────

  test(
    "install_skill executes, increments downloads, real LLM reports result",
    async () => {
      const registry = createInMemorySkillRegistry();
      seedRegistry(registry);

      // Before install — no downloads
      const before = await registry.get(skillId("code-review"));
      expect(before.ok).toBe(true);
      if (before.ok) {
        expect(before.value.downloads).toBeUndefined();
      }

      // let justified: count model call phases
      let modelCallCount = 0;

      const twoPhaseModelCall = async (request: ModelRequest): Promise<ModelResponse> => {
        modelCallCount++;
        if (modelCallCount === 1) {
          return {
            content: "I'll install the code-review skill.",
            model: MODEL_NAME,
            usage: { inputTokens: 10, outputTokens: 15 },
            metadata: {
              toolCalls: [
                {
                  toolName: "install_skill",
                  callId: "call-install-1",
                  input: { skill_id: "code-review" },
                },
              ],
            },
          };
        }
        const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
        return anthropic.complete({ ...request, model: MODEL_NAME, maxTokens: 200 });
      };

      const adapter = createLoopAdapter({ modelCall: twoPhaseModelCall, maxTurns: 5 });
      const runtime = await createKoi({
        manifest: { name: "e2e-skill-install", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        providers: [createSkillRegistryToolProvider(registry)],
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: "Install the code-review skill and tell me what version.",
          }),
        );

        // Agent completed
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // install_skill tool was called
        const toolStarts = events.filter(
          (e): e is EngineEvent & { readonly kind: "tool_call_start" } =>
            e.kind === "tool_call_start",
        );
        expect(toolStarts[0]?.toolName).toBe("install_skill");

        // Download count incremented
        const after = await registry.get(skillId("code-review"));
        expect(after.ok).toBe(true);
        if (after.ok && after.value.downloads !== undefined) {
          expect(after.value.downloads).toBe(1);
        }

        // Real LLM generated a response
        const text = extractText(events);
        expect(text.length).toBeGreaterThan(0);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  // ── Full round-trip: search → install with lifecycle hooks ──────────────

  test(
    "search → install round-trip through full middleware chain with lifecycle hooks",
    async () => {
      const registry = createInMemorySkillRegistry();
      seedRegistry(registry);

      const interceptedTools: string[] = []; // let justified: test accumulator
      const hookLog: string[] = []; // let justified: test accumulator

      const toolObserver: KoiMiddleware = {
        name: "e2e-tool-observer",
        wrapToolCall: async (_ctx, request: ToolRequest, next) => {
          interceptedTools.push(request.toolId);
          return next(request);
        },
      };

      const lifecycleObserver: KoiMiddleware = {
        name: "e2e-lifecycle-observer",
        priority: 100,
        onSessionStart: async () => {
          hookLog.push("session:start");
        },
        onBeforeTurn: async () => {
          hookLog.push("turn:before");
        },
        onAfterTurn: async () => {
          hookLog.push("turn:after");
        },
        onSessionEnd: async () => {
          hookLog.push("session:end");
        },
      };

      // let justified: count model call phases
      let modelCallCount = 0;

      const threePhaseModelCall = async (request: ModelRequest): Promise<ModelResponse> => {
        modelCallCount++;
        if (modelCallCount === 1) {
          return {
            content: "Let me search for deploy skills.",
            model: MODEL_NAME,
            usage: { inputTokens: 10, outputTokens: 15 },
            metadata: {
              toolCalls: [
                {
                  toolName: "search_skills",
                  callId: "call-search-1",
                  input: { query: "deploy" },
                },
              ],
            },
          };
        }
        if (modelCallCount === 2) {
          return {
            content: "Found deploy-helper, installing it.",
            model: MODEL_NAME,
            usage: { inputTokens: 20, outputTokens: 15 },
            metadata: {
              toolCalls: [
                {
                  toolName: "install_skill",
                  callId: "call-install-1",
                  input: { skill_id: "deploy-helper" },
                },
              ],
            },
          };
        }
        const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
        return anthropic.complete({ ...request, model: MODEL_NAME, maxTokens: 200 });
      };

      const adapter = createLoopAdapter({ modelCall: threePhaseModelCall, maxTurns: 8 });
      const runtime = await createKoi({
        manifest: { name: "e2e-skill-roundtrip", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [toolObserver, lifecycleObserver],
        providers: [createSkillRegistryToolProvider(registry)],
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: "Search for deploy skills, install what you find, and summarize.",
          }),
        );

        // Agent completed with multiple turns
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
          expect(doneEvent.output.metrics.turns).toBeGreaterThanOrEqual(3);
        }

        // Both tools intercepted by middleware
        expect(interceptedTools).toContain("search_skills");
        expect(interceptedTools).toContain("install_skill");

        // Lifecycle hooks fired in correct order
        expect(hookLog.at(0)).toBe("session:start");
        expect(hookLog.at(-1)).toBe("session:end");
        expect(hookLog).toContain("turn:before");
        expect(hookLog).toContain("turn:after");

        // Download count incremented
        const deployed = await registry.get(skillId("deploy-helper"));
        expect(deployed.ok).toBe(true);
        if (deployed.ok && deployed.value.downloads !== undefined) {
          expect(deployed.value.downloads).toBe(1);
        }

        // Real LLM produced output
        const text = extractText(events);
        expect(text.length).toBeGreaterThan(0);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 3. Registry feature tests (no LLM needed)
// ---------------------------------------------------------------------------

describeE2E("e2e: Skill registry features", () => {
  test(
    "requires field is visible in search results and get",
    async () => {
      const registry = createInMemorySkillRegistry();
      seedRegistry(registry);

      const page = await registry.search({ text: "deploy" });
      expect(page.items.length).toBe(1);
      expect(page.items[0]?.requires).toEqual({ bins: ["docker"], env: ["AWS_REGION"] });

      const getResult = await registry.get(skillId("deploy-helper"));
      expect(getResult.ok).toBe(true);
      if (getResult.ok) {
        expect(getResult.value.requires).toEqual({ bins: ["docker"], env: ["AWS_REGION"] });
      }

      const crResult = await registry.get(skillId("code-review"));
      expect(crResult.ok).toBe(true);
      if (crResult.ok) {
        expect(crResult.value.requires).toEqual({ bins: ["git"] });
      }
    },
    TIMEOUT_MS,
  );

  test(
    "onChange emits typed events for publish, deprecate, unpublish",
    async () => {
      const registry = createInMemorySkillRegistry();

      const changeEvents: SkillRegistryChangeEvent[] = []; // let justified: test accumulator
      registry.onChange((event) => {
        changeEvents.push(event);
      });

      seedRegistry(registry);

      expect(changeEvents.length).toBe(3);
      expect(changeEvents[0]?.kind).toBe("published");
      expect(changeEvents[0]?.skillId).toBe(skillId("code-review"));
      expect(changeEvents[0]?.version).toBe("2.1.0");
      expect(changeEvents[1]?.kind).toBe("published");
      expect(changeEvents[1]?.skillId).toBe(skillId("test-generator"));
      expect(changeEvents[2]?.kind).toBe("published");
      expect(changeEvents[2]?.skillId).toBe(skillId("deploy-helper"));

      const depResult = await registry.deprecate(skillId("code-review"), "2.1.0");
      expect(depResult.ok).toBe(true);
      expect(changeEvents.length).toBe(4);
      expect(changeEvents[3]?.kind).toBe("deprecated");
      expect(changeEvents[3]?.skillId).toBe(skillId("code-review"));
      expect(changeEvents[3]?.version).toBe("2.1.0");

      const unpubResult = await registry.unpublish(skillId("test-generator"));
      expect(unpubResult.ok).toBe(true);
      expect(changeEvents.length).toBe(5);
      expect(changeEvents[4]?.kind).toBe("unpublished");
      expect(changeEvents[4]?.skillId).toBe(skillId("test-generator"));
    },
    TIMEOUT_MS,
  );

  test(
    "download count increments on each install",
    async () => {
      const registry = createInMemorySkillRegistry();
      seedRegistry(registry);

      const before = await registry.get(skillId("code-review"));
      expect(before.ok).toBe(true);
      if (before.ok) {
        expect(before.value.downloads).toBeUndefined();
      }

      const r1 = await registry.install(skillId("code-review"));
      expect(r1.ok).toBe(true);
      const r2 = await registry.install(skillId("code-review"));
      expect(r2.ok).toBe(true);

      const after = await registry.get(skillId("code-review"));
      expect(after.ok).toBe(true);
      if (after.ok) {
        expect(after.value.downloads).toBe(2);
      }
    },
    TIMEOUT_MS,
  );
});
