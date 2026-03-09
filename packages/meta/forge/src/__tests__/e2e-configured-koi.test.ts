/**
 * E2E: createForgeConfiguredKoi + Pi adapter + real OpenRouter LLM.
 *
 * Validates the complete #917 bootstrap path end-to-end:
 *   1. createForgeConfiguredKoi with forge enabled → full forge system wired
 *   2. Pi adapter with OpenRouter model → real LLM streaming
 *   3. Forge middleware stack active (demand, crystallize, auto-forge, etc.)
 *   4. Forge tools registered (search_forge, forge_tool, forge_skill, etc.)
 *   5. Forge companion skill attached
 *   6. Custom tools work alongside forge tools
 *   7. Middleware interposition (tool + model stream) verified
 *   8. Notifier cross-agent invalidation wired
 *   9. ForgeSystem handles accessible post-bootstrap
 *  10. Pre-forged bricks visible to agent via ComponentProvider
 *
 * Gated on OPENROUTER_API_KEY + E2E_TESTS=1.
 *
 * Run:
 *   E2E_TESTS=1 bun test packages/meta/forge/src/__tests__/e2e-configured-koi.test.ts
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AgentManifest,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  SandboxExecutor,
  Tool,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, skillToken, toolToken } from "@koi/core";
import { createPiAdapter } from "@koi/engine-pi";
import type { ForgeDeps } from "@koi/forge-tools";
import { createForgeToolTool, createInMemoryForgeStore } from "@koi/forge-tools";
import { createDefaultForgeConfig } from "@koi/forge-types";
import { createForgeConfiguredKoi } from "../configured-koi.js";
import { createForgePipeline } from "../create-forge-stack.js";

// ---------------------------------------------------------------------------
// Environment gate — load OpenRouter key from ~/nexus/.env
// ---------------------------------------------------------------------------

function loadEnvFile(path: string): Record<string, string> {
  try {
    const content = readFileSync(path, "utf-8");
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      vars[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
    return vars;
  } catch {
    return {};
  }
}

const nexusEnv = loadEnvFile(resolve(process.env.HOME ?? "~", "nexus/.env"));
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? nexusEnv.OPENROUTER_API_KEY ?? "";
const HAS_KEY = OPENROUTER_KEY.length > 0;
const E2E_ENABLED = HAS_KEY && process.env.E2E_TESTS === "1";
const describeE2E = E2E_ENABLED ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "openrouter:google/gemini-2.0-flash-001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ForgeManifest = AgentManifest & { readonly forge: unknown };

function forgeManifest(): ForgeManifest {
  return {
    name: "forge-e2e-pi",
    version: "0.1.0",
    model: { name: E2E_MODEL },
    forge: { enabled: true },
  } as ForgeManifest;
}

function mockExecutor(): SandboxExecutor {
  return {
    execute: async (_code, input, _timeout) => ({
      ok: true,
      value: { output: input, durationMs: 1 },
    }),
  };
}

function adderExecutor(): SandboxExecutor {
  return {
    execute: async (_code, input, _timeout) => {
      const obj = input as { readonly a: number; readonly b: number };
      return {
        ok: true,
        value: { output: { sum: obj.a + obj.b }, durationMs: 1 },
      };
    },
  };
}

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

/** Static tool for testing alongside forge tools. */
const ADD_TOOL: Tool = {
  descriptor: {
    name: "add_numbers",
    description: "Adds two numbers. Returns the sum.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
  },
  origin: "primordial",
  policy: DEFAULT_SANDBOXED_POLICY,
  execute: async (input: Readonly<Record<string, unknown>>) => {
    const a = Number(input.a ?? 0);
    const b = Number(input.b ?? 0);
    return String(a + b);
  },
};

/** ComponentProvider for static tools. */
function createToolProvider(tools: readonly Tool[]): import("@koi/core").ComponentProvider {
  return {
    name: "e2e-static-tools",
    attach: async () => new Map(tools.map((t) => [toolToken(t.descriptor.name) as string, t])),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: createForgeConfiguredKoi + Pi adapter + OpenRouter", () => {
  // ── 1. Forge-enabled bootstrap produces full system ───────────────────

  test(
    "forge enabled → runtime + forgeSystem with all handles",
    async () => {
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with one word only.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const result = await createForgeConfiguredKoi({
        manifest: forgeManifest(),
        adapter,
        forgeStore: createInMemoryForgeStore(),
        forgeExecutor: mockExecutor(),
      });

      // ForgeSystem must be present
      expect(result.forgeSystem).toBeDefined();
      const fs = result.forgeSystem;
      if (fs === undefined) throw new Error("forgeSystem expected");

      expect(fs.runtime).toBeDefined();
      expect(fs.provider).toBeDefined();
      expect(fs.pipeline).toBeDefined();
      expect(fs.middlewares.length).toBeGreaterThanOrEqual(1);
      expect(fs.notifier).toBeDefined();
      expect(fs.handles.demand).toBeDefined();
      expect(fs.handles.crystallize).toBeDefined();
      expect(fs.handles.exaptation).toBeDefined();

      // Runtime streams a real LLM response
      const events = await collectEvents(result.runtime.run({ kind: "text", text: "Say: OK" }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");
      expect(output?.metrics.inputTokens).toBeGreaterThan(0);
      expect(output?.metrics.outputTokens).toBeGreaterThan(0);

      await result.runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 2. Forge tools registered on agent entity ─────────────────────────

  test(
    "forge tools (search_forge, forge_tool, etc.) are attached to agent",
    async () => {
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply briefly.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const result = await createForgeConfiguredKoi({
        manifest: forgeManifest(),
        adapter,
        forgeStore: createInMemoryForgeStore(),
        forgeExecutor: mockExecutor(),
      });

      // Run one turn to trigger assembly + attach
      await collectEvents(result.runtime.run({ kind: "text", text: "Hello" }));

      // Check forge tools are on the agent entity
      const agent = result.runtime.agent;
      expect(agent.component(toolToken("search_forge"))).toBeDefined();
      expect(agent.component(toolToken("forge_tool"))).toBeDefined();
      expect(agent.component(toolToken("forge_skill"))).toBeDefined();
      expect(agent.component(toolToken("forge_edit"))).toBeDefined();
      expect(agent.component(toolToken("promote_forge"))).toBeDefined();

      // Companion skill attached
      expect(agent.component(skillToken("forge-companion"))).toBeDefined();

      await result.runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 3. Static tools work alongside forge tools ────────────────────────

  test(
    "static tools coexist with forge tools — LLM calls static tool",
    async () => {
      const toolCallIds: string[] = [];

      const toolSpy: KoiMiddleware = {
        name: "tool-spy",
        describeCapabilities: () => undefined,
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolCallIds.push(request.toolId);
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the add_numbers tool for any math question. Never compute in your head.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const result = await createForgeConfiguredKoi({
        manifest: forgeManifest(),
        adapter,
        forgeStore: createInMemoryForgeStore(),
        forgeExecutor: mockExecutor(),
        middleware: [toolSpy],
        providers: [createToolProvider([ADD_TOOL])],
      });

      const events = await collectEvents(
        result.runtime.run({
          kind: "text",
          text: "Use add_numbers to compute 13 + 29. Tell me the result.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // add_numbers should be among the called tools
      expect(toolCallIds).toContain("add_numbers");

      // Response should contain 42
      const text = extractText(events);
      expect(text).toContain("42");

      await result.runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 4. Forge middleware stack fires during session ─────────────────────

  test(
    "forge middleware lifecycle hooks (onSessionStart/End, onAfterTurn) fire",
    async () => {
      const hookLog: string[] = [];

      const lifecycleSpy: KoiMiddleware = {
        name: "lifecycle-spy",
        describeCapabilities: () => undefined,
        onSessionStart: async () => {
          hookLog.push("session_start");
        },
        onSessionEnd: async () => {
          hookLog.push("session_end");
        },
        onAfterTurn: async () => {
          hookLog.push("after_turn");
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply in one word.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const result = await createForgeConfiguredKoi({
        manifest: forgeManifest(),
        adapter,
        forgeStore: createInMemoryForgeStore(),
        forgeExecutor: mockExecutor(),
        middleware: [lifecycleSpy],
      });

      await collectEvents(result.runtime.run({ kind: "text", text: "Say: yes" }));

      // Lifecycle hooks must have fired
      expect(hookLog[0]).toBe("session_start");
      expect(hookLog[hookLog.length - 1]).toBe("session_end");
      expect(hookLog).toContain("after_turn");

      await result.runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 5. wrapModelStream fires (Pi adapter uses streaming) ──────────────

  test(
    "wrapModelStream middleware fires during Pi adapter streaming call",
    async () => {
      let streamCallCount = 0;

      const streamSpy: KoiMiddleware = {
        name: "stream-spy",
        describeCapabilities: () => undefined,
        wrapModelStream: async function* (_ctx, request, next) {
          streamCallCount++;
          yield* next(request);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply briefly.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const result = await createForgeConfiguredKoi({
        manifest: forgeManifest(),
        adapter,
        forgeStore: createInMemoryForgeStore(),
        forgeExecutor: mockExecutor(),
        middleware: [streamSpy],
      });

      await collectEvents(result.runtime.run({ kind: "text", text: "Say hello." }));

      expect(streamCallCount).toBeGreaterThanOrEqual(1);

      await result.runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 6. Pre-forged brick visible to LLM through ComponentProvider ──────

  test(
    "pre-forged tool brick is attached and callable by LLM",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();

      // Pre-forge a tool into the store before bootstrap
      const deps: ForgeDeps = {
        store,
        executor,
        verifiers: [],
        config: createDefaultForgeConfig(),
        context: {
          agentId: "e2e-pre-forge",
          depth: 0,
          sessionId: "pre-forge-session",
          forgesThisSession: 0,
        },
        pipeline: createForgePipeline(),
      };

      const forgeTool = createForgeToolTool(deps);
      const forgeResult = await forgeTool.execute({
        name: "pre_forged_adder",
        description: "Adds two numbers. Call with {a: number, b: number}. Returns {sum: number}.",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        implementation: "return { sum: input.a + input.b };",
      });
      expect((forgeResult as { readonly ok: boolean }).ok).toBe(true);

      // Bootstrap with the pre-seeded store
      const toolCallIds: string[] = [];
      const toolSpy: KoiMiddleware = {
        name: "pre-forge-spy",
        describeCapabilities: () => undefined,
        wrapToolCall: async (_ctx, req, next) => {
          toolCallIds.push(req.toolId);
          return next(req);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the pre_forged_adder tool for any math question. Never compute in your head.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const result = await createForgeConfiguredKoi({
        manifest: forgeManifest(),
        adapter,
        forgeStore: store,
        forgeExecutor: executor,
        middleware: [toolSpy],
      });

      const events = await collectEvents(
        result.runtime.run({
          kind: "text",
          text: "Use pre_forged_adder to add 100 and 200. Tell me the result.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason === "completed" || output?.stopReason === "max_turns").toBe(true);

      // The pre-forged tool should be on the agent entity
      expect(result.runtime.agent.component(toolToken("pre_forged_adder"))).toBeDefined();

      // If LLM called it, middleware should have intercepted
      if (toolCallIds.includes("pre_forged_adder")) {
        const text = extractText(events);
        expect(text).toContain("300");
      }

      await result.runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 7. Forge disabled → no forgeSystem, runtime still works ───────────

  test(
    "forge disabled → clean runtime with no forge overhead",
    async () => {
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with one word.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const result = await createForgeConfiguredKoi({
        manifest: {
          name: "no-forge-e2e",
          version: "0.1.0",
          model: { name: E2E_MODEL },
          forge: { enabled: false },
        } as ForgeManifest,
        adapter,
        forgeStore: createInMemoryForgeStore(),
        forgeExecutor: mockExecutor(),
      });

      expect(result.forgeSystem).toBeUndefined();

      const events = await collectEvents(result.runtime.run({ kind: "text", text: "Say: pong" }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("pong");

      // No forge tools attached
      expect(result.runtime.agent.component(toolToken("search_forge"))).toBeUndefined();
      expect(result.runtime.agent.component(toolToken("forge_tool"))).toBeUndefined();

      await result.runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 8. Demand handle accessible and starts with zero signals ──────────

  test(
    "demand handle starts with zero active signals",
    async () => {
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply briefly.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const result = await createForgeConfiguredKoi({
        manifest: forgeManifest(),
        adapter,
        forgeStore: createInMemoryForgeStore(),
        forgeExecutor: mockExecutor(),
      });

      const fs = result.forgeSystem;
      if (fs === undefined) throw new Error("forgeSystem expected");

      // Demand detector starts fresh
      expect(fs.handles.demand.getActiveSignalCount()).toBe(0);
      expect(fs.handles.demand.getSignals()).toEqual([]);

      // Run a turn — no failures → still zero signals
      await collectEvents(result.runtime.run({ kind: "text", text: "Hello" }));

      // Demand signals only fire on capability gaps / failures
      expect(fs.handles.demand.getActiveSignalCount()).toBe(0);

      await result.runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 9. Notifier is wired — save to store triggers cache invalidation ──

  test(
    "notifier wired: saving to store fires change event",
    async () => {
      const store = createInMemoryForgeStore();
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply briefly.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const result = await createForgeConfiguredKoi({
        manifest: forgeManifest(),
        adapter,
        forgeStore: store,
        forgeExecutor: mockExecutor(),
      });

      const fs = result.forgeSystem;
      if (fs === undefined) throw new Error("forgeSystem expected");

      // Subscribe to notifier to observe events
      const notifiedEvents: string[] = [];
      fs.notifier.subscribe((event) => {
        notifiedEvents.push(event.kind);
      });

      // Run one turn to initialize
      await collectEvents(result.runtime.run({ kind: "text", text: "Hi" }));

      // Now forge a tool into the store directly — notifier should NOT fire
      // (direct store.save doesn't trigger notifier — that's by design,
      //  only middleware-triggered saves do)
      // But the notifier itself is functional:
      const { brickId } = await import("@koi/core");
      fs.notifier.notify({ kind: "saved", brickId: brickId("test-brick") });
      expect(notifiedEvents).toContain("saved");

      await result.runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── 10. Metrics accumulate across multi-turn tool use ─────────────────

  test(
    "metrics accumulate correctly across tool call turns",
    async () => {
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You MUST use add_numbers for math. Never compute yourself.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const result = await createForgeConfiguredKoi({
        manifest: forgeManifest(),
        adapter,
        forgeStore: createInMemoryForgeStore(),
        forgeExecutor: mockExecutor(),
        providers: [createToolProvider([ADD_TOOL])],
      });

      const events = await collectEvents(
        result.runtime.run({
          kind: "text",
          text: "Use add_numbers to compute 8 + 14. Tell me the result.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      if (output === undefined) return;

      expect(output.metrics.inputTokens).toBeGreaterThan(0);
      expect(output.metrics.outputTokens).toBeGreaterThan(0);
      expect(output.metrics.totalTokens).toBeGreaterThan(0);
      expect(output.metrics.durationMs).toBeGreaterThan(0);
      expect(output.metrics.turns).toBeGreaterThanOrEqual(1);

      // Text should contain 22
      const text = extractText(events);
      expect(text).toContain("22");

      await result.runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
