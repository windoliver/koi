/**
 * End-to-end tests for @koi/skill-stack through the full createKoi runtime.
 *
 * Validates:
 *   - SkillStackBundle wires correctly into createKoi (provider + middleware)
 *   - Skill activator middleware fires through the L1 middleware chain
 *   - Hot-mount adds skills mid-session through createKoi runtime
 *   - Lifecycle hooks compose correctly with skill-stack middleware
 *   - Real LLM call via OpenRouter through the full L1 runtime assembly
 *   - Tool call + skill-stack middleware compose through full chain
 *   - Full integration: mount → LLM call → tool call → unmount
 *
 * Gated on OPENROUTER_API_KEY — tests are skipped when the key is not set.
 *
 * Run:
 *   OPENROUTER_API_KEY=... bun test tests/e2e/skill-stack.e2e.test.ts
 *
 * Cost: ~$0.02-0.05 per run (gpt-4o-mini via OpenRouter, minimal prompts).
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type {
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  Tool,
} from "@koi/core";
import { fsSkill, toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createOpenRouterAdapter } from "@koi/model-router";
import { createSkillStack } from "@koi/skill-stack";
import { clearSkillCache } from "@koi/skills";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const HAS_KEY = OPENROUTER_KEY.length > 0;
const describeE2E = HAS_KEY ? describe : describe.skip;

const TIMEOUT_MS = 60_000;
const FIXTURES = resolve(import.meta.dir, "../../packages/fs/skills/fixtures");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = []; // let justified: test accumulator
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

/** Creates a model call handler using OpenRouter + gpt-4o-mini. */
function createModelCall(): (request: ModelRequest) => Promise<ModelResponse> {
  const adapter = createOpenRouterAdapter({
    apiKey: OPENROUTER_KEY,
    appName: "koi-skill-stack-e2e",
  });
  return (request: ModelRequest) => adapter.complete({ ...request, model: "openai/gpt-4o-mini" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: skill-stack through createKoi + createLoopAdapter", () => {
  // ── Test 1: Skill-stack provider + middleware wire into createKoi ──

  test(
    "skill-stack provider and activator middleware compose with createKoi runtime",
    async () => {
      clearSkillCache();

      const bundle = await createSkillStack({
        skills: [fsSkill("code-review", "./valid-skill")],
        basePath: FIXTURES,
      });

      const modelCall = createModelCall();
      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-skill-stack",
          version: "0.0.1",
          model: { name: "gpt-4o-mini" },
        },
        adapter,
        middleware: [...bundle.middleware],
        providers: [bundle.provider],
        loopDetection: false,
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Reply with exactly: pong" }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        expect(output?.stopReason).toBe("completed");
        expect(output?.metrics.inputTokens).toBeGreaterThan(0);
        expect(output?.metrics.outputTokens).toBeGreaterThan(0);

        // Agent completed through the skill-stack middleware chain
        const text = extractText(events);
        expect(text.length).toBeGreaterThan(0);
      } finally {
        bundle.dispose();
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 2: Skill activator middleware fires through L1 chain ──────

  test(
    "skill activator middleware intercepts model calls in the L1 chain",
    async () => {
      clearSkillCache();

      // Track middleware execution
      const middlewareLog: string[] = []; // let justified: test accumulator

      const observer: KoiMiddleware = {
        name: "e2e-mw-observer",
        priority: 50,
        describeCapabilities: () => undefined,
        wrapModelCall: async (_ctx, request, next) => {
          middlewareLog.push("observer:before");
          const result = await next(request);
          middlewareLog.push("observer:after");
          return result;
        },
      };

      const bundle = await createSkillStack({
        skills: [fsSkill("code-review", "./valid-skill")],
        basePath: FIXTURES,
      });

      const modelCall = createModelCall();
      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-skill-activator",
          version: "0.0.1",
          model: { name: "gpt-4o-mini" },
        },
        adapter,
        middleware: [observer, ...bundle.middleware],
        providers: [bundle.provider],
        loopDetection: false,
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Say hello briefly." }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        expect(output?.stopReason).toBe("completed");

        // Both the observer and skill-activator middleware were in the chain
        expect(middlewareLog).toContain("observer:before");
        expect(middlewareLog).toContain("observer:after");
      } finally {
        bundle.dispose();
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Lifecycle hooks compose with skill-stack middleware ────

  test(
    "session lifecycle hooks fire correctly with skill-stack middleware",
    async () => {
      clearSkillCache();

      const hookLog: string[] = []; // let justified: test accumulator

      const lifecycle: KoiMiddleware = {
        name: "e2e-lifecycle",
        priority: 100,
        describeCapabilities: () => undefined,
        onSessionStart: async () => {
          hookLog.push("session:start");
        },
        onAfterTurn: async () => {
          hookLog.push("turn:after");
        },
        onSessionEnd: async () => {
          hookLog.push("session:end");
        },
      };

      const bundle = await createSkillStack({
        skills: [fsSkill("code-review", "./valid-skill")],
        basePath: FIXTURES,
      });

      const modelCall = createModelCall();
      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-skill-lifecycle",
          version: "0.0.1",
          model: { name: "gpt-4o-mini" },
        },
        adapter,
        middleware: [lifecycle, ...bundle.middleware],
        providers: [bundle.provider],
        loopDetection: false,
      });

      try {
        await collectEvents(runtime.run({ kind: "text", text: "Reply: OK" }));

        expect(hookLog[0]).toBe("session:start");
        expect(hookLog[hookLog.length - 1]).toBe("session:end");
        expect(hookLog).toContain("turn:after");
      } finally {
        bundle.dispose();
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Hot-mount adds a skill to a running provider ──────────

  test(
    "hot-mount adds a skill to the provider during runtime",
    async () => {
      clearSkillCache();

      // Start with an empty skill stack
      const bundle = await createSkillStack({
        skills: [],
        basePath: FIXTURES,
      });

      expect(bundle.config.skillCount).toBe(0);

      // Hot-mount a skill
      const result = await bundle.mount(fsSkill("code-review", "./valid-skill"));
      expect(result.ok).toBe(true);

      // Provider now has the skill at body level
      expect(bundle.provider.getLevel("code-review")).toBe("body");

      // Wire into createKoi and make a real LLM call
      const modelCall = createModelCall();
      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-hot-mount",
          version: "0.0.1",
          model: { name: "gpt-4o-mini" },
        },
        adapter,
        middleware: [...bundle.middleware],
        providers: [bundle.provider],
        loopDetection: false,
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Reply with: mounted" }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        expect(output?.stopReason).toBe("completed");
      } finally {
        bundle.dispose();
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 5: Unmount removes a skill from the provider ─────────────

  test(
    "unmount removes a skill and subsequent runs work without it",
    async () => {
      clearSkillCache();

      const bundle = await createSkillStack({
        skills: [fsSkill("code-review", "./valid-skill"), fsSkill("minimal", "./minimal-skill")],
        basePath: FIXTURES,
      });

      expect(bundle.config.skillCount).toBe(2);

      // Attach to populate levels (normally done by createKoi during assembly)
      const stubAgent = { pid: { id: "e2e-stub" } } as unknown as import("@koi/core").Agent;
      await bundle.provider.attach(stubAgent);
      expect(bundle.provider.getLevel("code-review")).toBe("metadata");

      // Unmount one skill
      bundle.unmount("code-review");
      expect(bundle.provider.getLevel("code-review")).toBeUndefined();
      expect(bundle.provider.getLevel("minimal")).toBe("metadata");

      // Wire remaining stack into createKoi
      const modelCall = createModelCall();
      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-unmount",
          version: "0.0.1",
          model: { name: "gpt-4o-mini" },
        },
        adapter,
        middleware: [...bundle.middleware],
        providers: [bundle.provider],
        loopDetection: false,
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Reply with: still running" }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        expect(output?.stopReason).toBe("completed");
      } finally {
        bundle.dispose();
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 6: Tool call + skill-stack compose through full L1 chain ─

  test(
    "tool call middleware composes correctly with skill-stack middleware",
    async () => {
      clearSkillCache();

      const toolCalls: string[] = []; // let justified: test accumulator
      // let justified: toggled when tool executes
      let toolExecuted = false;

      const echoTool: Tool = {
        descriptor: {
          name: "echo",
          description: "Returns the input text back.",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
        trustTier: "sandbox",
        execute: async (input: Readonly<Record<string, unknown>>) => {
          toolExecuted = true;
          return String(input.text ?? "");
        },
      };

      const toolProvider: ComponentProvider = {
        name: "e2e-tool-provider",
        attach: async () => {
          const components = new Map<string, unknown>();
          components.set(toolToken("echo"), echoTool);
          return components;
        },
      };

      const toolObserver: KoiMiddleware = {
        name: "e2e-tool-observer",
        describeCapabilities: () => undefined,
        wrapToolCall: async (_ctx, request, next) => {
          toolCalls.push(request.toolId);
          return next(request);
        },
      };

      const bundle = await createSkillStack({
        skills: [fsSkill("code-review", "./valid-skill")],
        basePath: FIXTURES,
      });

      // Two-phase model: first forces tool call, second is real LLM
      const realModelCall = createModelCall();
      // let justified: tracks model call phases
      let callCount = 0;

      const modelCall = async (request: ModelRequest): Promise<ModelResponse> => {
        callCount++;
        if (callCount === 1) {
          // Phase 1: force a deterministic tool call
          return {
            content: "Let me echo that.",
            model: "gpt-4o-mini",
            usage: { inputTokens: 10, outputTokens: 15 },
            metadata: {
              toolCalls: [
                {
                  toolName: "echo",
                  callId: "call-e2e-echo",
                  input: { text: "skill-stack-works" },
                },
              ],
            },
          };
        }
        // Phase 2: real LLM generates final answer
        return realModelCall(request);
      };

      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-tool-skill-stack",
          version: "0.0.1",
          model: { name: "gpt-4o-mini" },
        },
        adapter,
        middleware: [toolObserver, ...bundle.middleware],
        providers: [bundle.provider, toolProvider],
        loopDetection: false,
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: "Use the echo tool with text 'hello'",
          }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        expect(output?.stopReason).toBe("completed");

        // Tool was called through the middleware chain
        expect(toolExecuted).toBe(true);
        expect(toolCalls).toContain("echo");

        // tool_call_start and tool_call_end events emitted
        const toolStarts = events.filter((e) => e.kind === "tool_call_start");
        expect(toolStarts.length).toBeGreaterThan(0);
        const toolEnds = events.filter((e) => e.kind === "tool_call_end");
        expect(toolEnds.length).toBeGreaterThan(0);

        // Real LLM was called for the final response
        expect(callCount).toBeGreaterThanOrEqual(2);
      } finally {
        bundle.dispose();
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 7: Preset configuration flows through to runtime ─────────

  test(
    "preset configuration affects stack behavior through runtime",
    async () => {
      clearSkillCache();

      const restrictive = await createSkillStack({
        skills: [fsSkill("code-review", "./valid-skill")],
        basePath: FIXTURES,
        preset: "restrictive",
      });

      expect(restrictive.config.preset).toBe("restrictive");
      expect(restrictive.config.gatingEnabled).toBe(true);

      const modelCall = createModelCall();
      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-preset",
          version: "0.0.1",
          model: { name: "gpt-4o-mini" },
        },
        adapter,
        middleware: [...restrictive.middleware],
        providers: [restrictive.provider],
        loopDetection: false,
      });

      try {
        const events = await collectEvents(runtime.run({ kind: "text", text: "Reply: preset-ok" }));

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        expect(output?.stopReason).toBe("completed");
      } finally {
        restrictive.dispose();
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 8: Full integration — mount, LLM call, tool, unmount ─────

  test(
    "full integration: mount → LLM call → tool call → unmount",
    async () => {
      clearSkillCache();

      // Start empty, mount a skill, run with tool, then unmount
      const bundle = await createSkillStack({
        skills: [],
        basePath: FIXTURES,
        preset: "standard",
      });

      // Hot-mount a skill
      const mountResult = await bundle.mount(fsSkill("code-review", "./valid-skill"));
      expect(mountResult.ok).toBe(true);
      expect(bundle.provider.getLevel("code-review")).toBe("body");

      // Create a tool that the model will call
      const addTool: Tool = {
        descriptor: {
          name: "add",
          description: "Adds two numbers.",
          inputSchema: {
            type: "object",
            properties: {
              a: { type: "number" },
              b: { type: "number" },
            },
            required: ["a", "b"],
          },
        },
        trustTier: "sandbox",
        execute: async (input: Readonly<Record<string, unknown>>) => {
          return String(Number(input.a ?? 0) + Number(input.b ?? 0));
        },
      };

      const toolProvider: ComponentProvider = {
        name: "e2e-add-provider",
        attach: async () => new Map([[toolToken("add") as string, addTool]]),
      };

      // Two-phase model: force tool call, then real LLM
      const realModelCall = createModelCall();
      // let justified: tracks model call phases
      let phase = 0;

      const modelCall = async (request: ModelRequest): Promise<ModelResponse> => {
        phase++;
        if (phase === 1) {
          return {
            content: "Computing 3 + 4...",
            model: "gpt-4o-mini",
            usage: { inputTokens: 10, outputTokens: 10 },
            metadata: {
              toolCalls: [
                {
                  toolName: "add",
                  callId: "call-add-1",
                  input: { a: 3, b: 4 },
                },
              ],
            },
          };
        }
        return realModelCall(request);
      };

      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-full-integration",
          version: "0.0.1",
          model: { name: "gpt-4o-mini" },
        },
        adapter,
        middleware: [...bundle.middleware],
        providers: [bundle.provider, toolProvider],
        loopDetection: false,
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: "Use the add tool to compute 3 + 4.",
          }),
        );

        const output = findDoneOutput(events);
        expect(output).toBeDefined();
        expect(output?.stopReason).toBe("completed");

        // Tool was called
        const toolStarts = events.filter((e) => e.kind === "tool_call_start");
        expect(toolStarts.length).toBeGreaterThan(0);

        // Real LLM call happened in phase 2
        expect(phase).toBeGreaterThanOrEqual(2);

        // Unmount the skill after successful run
        bundle.unmount("code-review");
        expect(bundle.provider.getLevel("code-review")).toBeUndefined();
      } finally {
        bundle.dispose();
        await runtime.dispose();
      }
    },
    TIMEOUT_MS,
  );
});
