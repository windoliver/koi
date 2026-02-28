/**
 * E2E test — Unified Brick Auto-Discovery through the full L1 runtime.
 *
 * Validates that all 5 BrickKinds flow through the discover → verify → attach
 * pipeline using createKoi + createPiAdapter with real LLM calls (Anthropic).
 *
 * Coverage:
 *   1. Forged tool: save → attach → LLM calls it → result returned
 *   2. Forged skill: save → attach → queryable as SkillComponent on agent entity
 *   3. Forged agent: save → attach → queryable as AgentDescriptor on agent entity
 *   4. ForgeRuntime.resolve(): generic per-kind resolution with requires enforcement
 *   5. ForgeRuntime hot-attach: tool forged mid-session → LLM calls it next turn
 *   6. Middleware chain: middleware spy intercepts forged tool calls
 *   7. Mixed pipeline: all 5 kinds in one pass, each under correct token
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1.
 *
 * Run:
 *   E2E_TESTS=1 bun test packages/forge/__tests__/brick-auto-discovery.e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentDescriptor,
  AgentManifest,
  BrickArtifact,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  SkillComponent,
  ToolRequest,
} from "@koi/core";
import { agentToken, brickId, skillToken, toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { computeBrickId } from "@koi/hash";
import {
  createTestAgentArtifact,
  createTestImplementationArtifact,
  createTestSkillArtifact,
  createTestToolArtifact,
} from "@koi/test-utils";
import { createForgeComponentProvider } from "../src/forge-component-provider.js";
import { createForgeRuntime } from "../src/forge-runtime.js";
import { createInMemoryForgeStore } from "../src/memory-store.js";
import type { SandboxExecutor, TieredSandboxExecutor } from "../src/types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const E2E_MANIFEST: AgentManifest = {
  name: "brick-discovery-e2e",
  version: "1.0.0",
  model: { name: "claude-haiku" },
};

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

function echoExecutor(): SandboxExecutor {
  return {
    execute: async (_code, input, _timeout) => ({
      ok: true,
      value: { output: input, durationMs: 1 },
    }),
  };
}

function mockTiered(exec: SandboxExecutor): TieredSandboxExecutor {
  return {
    forTier: (tier) => ({
      executor: exec,
      requestedTier: tier,
      resolvedTier: tier,
      fallback: false,
    }),
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

// ---------------------------------------------------------------------------
// 1. Forged tool callable by LLM (Pi adapter — tool schemas sent to API)
// ---------------------------------------------------------------------------

describeE2E("e2e: unified brick auto-discovery through createKoi + Pi adapter", () => {
  test(
    "forged tool attached via ComponentProvider is callable by LLM",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();

      // Save a pre-forged tool artifact directly to the store
      // Use computeBrickId for valid content-addressed ID (passes integrity checks)
      const adderImpl = "return { sum: input.a + input.b };";
      const toolArtifact = createTestToolArtifact({
        id: computeBrickId("tool", adderImpl),
        name: "adder",
        description: "Adds two numbers. Call with {a: number, b: number}. Returns {sum: number}.",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        implementation: adderImpl,
      });
      await store.save(toolArtifact);

      // Wire ForgeComponentProvider → createKoi → createPiAdapter
      const forgeProvider = createForgeComponentProvider({
        store,
        executor: mockTiered(executor),
      });

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You are a test assistant. When asked to add numbers, ALWAYS use the adder tool. Never compute mentally.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: piAdapter,
        providers: [forgeProvider],
        loopDetection: false,
        limits: { maxTurns: 5, maxDurationMs: 60_000, maxTokens: 10_000 },
      });

      // Verify tool is attached to entity
      const attached = runtime.agent.component(toolToken("adder"));
      expect(attached).toBeDefined();

      // Run with real LLM
      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the adder tool to add 17 and 25. Return ONLY the numeric result.",
        }),
      );
      await runtime.dispose();

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.metrics.inputTokens).toBeGreaterThan(0);
      expect(output?.metrics.outputTokens).toBeGreaterThan(0);

      // Pi adapter sends tool schemas — LLM should have called the tool
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      const toolEnds = events.filter((e) => e.kind === "tool_call_end");
      expect(toolStarts.length).toBeGreaterThanOrEqual(1);
      expect(toolEnds.length).toBeGreaterThanOrEqual(1);

      // Verify the correct tool was called
      const startEvent = toolStarts[0] as EngineEvent & { readonly kind: "tool_call_start" };
      expect(startEvent.toolName).toBe("adder");

      // Verify the response mentions 42
      const text = extractText(events);
      expect(text).toContain("42");
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 2. Forged skill queryable as SkillComponent
  // -------------------------------------------------------------------------

  test(
    "forged skill attached as SkillComponent queryable on agent entity",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = echoExecutor();

      // Save a skill artifact
      const skillArtifact = createTestSkillArtifact({
        id: brickId("skill-research"),
        name: "research",
        description: "Deep research methodology",
        content: "# Research Skill\n\nAlways cite sources and verify claims.",
        tags: ["research", "methodology"],
      });
      await store.save(skillArtifact);

      // Also save a tool so the agent has something to respond about
      const echoImpl = "return input;";
      const toolArtifact = createTestToolArtifact({
        id: computeBrickId("tool", echoImpl),
        name: "echo",
        description: "Returns input as-is. Call with any JSON object.",
        inputSchema: { type: "object" },
        implementation: echoImpl,
      });
      await store.save(toolArtifact);

      const forgeProvider = createForgeComponentProvider({
        store,
        executor: mockTiered(executor),
      });

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a test assistant. Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: piAdapter,
        providers: [forgeProvider],
        loopDetection: false,
        limits: { maxTurns: 2, maxDurationMs: 30_000, maxTokens: 5_000 },
      });

      // Query skill components on the agent entity
      const skills = runtime.agent.query<SkillComponent>("skill:");
      expect(skills.size).toBeGreaterThanOrEqual(1);

      const researchSkill = skills.get(
        skillToken("research") as import("@koi/core").SubsystemToken<SkillComponent>,
      );
      expect(researchSkill).toBeDefined();
      expect(researchSkill?.name).toBe("research");
      expect(researchSkill?.description).toBe("Deep research methodology");
      expect(researchSkill?.content).toBe(
        "# Research Skill\n\nAlways cite sources and verify claims.",
      );
      expect(researchSkill?.tags).toEqual(["research", "methodology"]);

      // Run to prove the agent still works with mixed brick kinds
      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly: ok" }),
      );
      await runtime.dispose();

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 3. Forged agent queryable as AgentDescriptor
  // -------------------------------------------------------------------------

  test(
    "forged agent attached as AgentDescriptor queryable on agent entity",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = echoExecutor();

      // Save an agent artifact
      const agentArtifact = createTestAgentArtifact({
        id: brickId("agent-planner"),
        name: "planner",
        description: "Strategic planning agent for complex tasks",
        manifestYaml: "name: planner\nversion: 1.0.0\nmodel:\n  name: claude-haiku",
      });
      await store.save(agentArtifact);

      const forgeProvider = createForgeComponentProvider({
        store,
        executor: mockTiered(executor),
      });

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a test assistant. Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: piAdapter,
        providers: [forgeProvider],
        loopDetection: false,
        limits: { maxTurns: 2, maxDurationMs: 30_000, maxTokens: 5_000 },
      });

      // Query agent components on the entity
      const agents = runtime.agent.query<AgentDescriptor>("agent:");
      expect(agents.size).toBeGreaterThanOrEqual(1);

      const plannerAgent = agents.get(
        agentToken("planner") as import("@koi/core").SubsystemToken<AgentDescriptor>,
      );
      expect(plannerAgent).toBeDefined();
      expect(plannerAgent?.name).toBe("planner");
      expect(plannerAgent?.description).toBe("Strategic planning agent for complex tasks");
      expect(plannerAgent?.manifestYaml).toContain("name: planner");

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly: ok" }),
      );
      await runtime.dispose();

      expect(findDoneOutput(events)).toBeDefined();
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 4. ForgeRuntime.resolve() with requires enforcement
  // -------------------------------------------------------------------------

  test(
    "ForgeRuntime.resolve() returns typed components and enforces requires",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();

      // Save a skill with no requires (should resolve)
      await store.save(
        createTestSkillArtifact({
          id: brickId("skill-coding"),
          name: "coding",
          description: "Coding best practices",
          content: "# Coding\n\nWrite clean code.",
        }),
      );

      // Save a tool (needed to satisfy requires.tools)
      const fmtImpl = "return input;";
      await store.save(
        createTestToolArtifact({
          id: computeBrickId("tool", fmtImpl),
          name: "formatter",
          description: "Formats code",
          inputSchema: { type: "object" },
          implementation: fmtImpl,
        }),
      );

      // Save a skill that requires a tool that exists
      await store.save(
        createTestSkillArtifact({
          id: brickId("skill-format"),
          name: "format-skill",
          description: "Format skill requiring formatter tool",
          content: "# Format\n\nUse the formatter tool.",
          requires: { tools: ["formatter"] },
        }),
      );

      // Save a skill that requires a tool that does NOT exist
      await store.save(
        createTestSkillArtifact({
          id: brickId("skill-gated"),
          name: "gated-skill",
          description: "Gated by missing tool",
          content: "# Gated",
          requires: { tools: ["nonexistent-tool"] },
        }),
      );

      // Save an agent descriptor
      await store.save(
        createTestAgentArtifact({
          id: brickId("agent-reviewer"),
          name: "reviewer",
          description: "Code reviewer agent",
          manifestYaml: "name: reviewer\nversion: 1.0.0",
        }),
      );

      const forgeRuntime = createForgeRuntime({
        store,
        executor: mockTiered(executor),
      });

      // resolve('skill', 'coding') — no requires, should succeed
      const coding = await forgeRuntime.resolve?.("skill", "coding");
      expect(coding).toBeDefined();
      expect((coding as SkillComponent).content).toBe("# Coding\n\nWrite clean code.");

      // resolve('skill', 'format-skill') — requires.tools satisfied
      const formatSkill = await forgeRuntime.resolve?.("skill", "format-skill");
      expect(formatSkill).toBeDefined();
      expect((formatSkill as SkillComponent).content).toBe("# Format\n\nUse the formatter tool.");

      // resolve('skill', 'gated-skill') — requires.tools NOT satisfied
      const gated = await forgeRuntime.resolve?.("skill", "gated-skill");
      expect(gated).toBeUndefined();

      // resolve('agent', 'reviewer') — agent descriptor
      const reviewer = await forgeRuntime.resolve?.("agent", "reviewer");
      expect(reviewer).toBeDefined();
      expect((reviewer as AgentDescriptor).manifestYaml).toContain("name: reviewer");

      // resolve('tool', 'formatter') — delegates to resolveTool with integrity checks
      const tool = await forgeRuntime.resolve?.("tool", "formatter");
      expect(tool).toBeDefined();

      // resolve unknown name — returns undefined
      const unknown = await forgeRuntime.resolve?.("skill", "nonexistent");
      expect(unknown).toBeUndefined();

      // Wire the ForgeRuntime into a real createKoi run
      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a test assistant. Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const koiRuntime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: piAdapter,
        forge: forgeRuntime,
        loopDetection: false,
        limits: { maxTurns: 2, maxDurationMs: 30_000, maxTokens: 5_000 },
      });

      const events = await collectEvents(
        koiRuntime.run({ kind: "text", text: "Reply with: resolved" }),
      );
      await koiRuntime.dispose();
      forgeRuntime.dispose?.();

      expect(findDoneOutput(events)).toBeDefined();
      expect(extractText(events).toLowerCase()).toContain("resolved");
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 5. ForgeRuntime hot-attach: tool forged mid-assembly still works
  // -------------------------------------------------------------------------

  test(
    "ForgeRuntime hot-attach: tool added to store is resolvable via forge runtime",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();

      // Start with an empty store
      const forgeRuntime = createForgeRuntime({
        store,
        executor: mockTiered(executor),
      });

      // No tool yet
      const before = await forgeRuntime.resolveTool("late-adder");
      expect(before).toBeUndefined();

      // Save a tool to the store (simulates forging mid-session)
      // Use computeBrickId for a valid content-addressed ID that passes integrity checks
      const lateImpl = "return { sum: input.a + input.b };";
      await store.save(
        createTestToolArtifact({
          id: computeBrickId("tool", lateImpl),
          name: "late-adder",
          description: "Adds two numbers (forged late)",
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
          },
          implementation: lateImpl,
        }),
      );

      // Wait for store.watch to fire and invalidate cache
      await new Promise((r) => setTimeout(r, 50));

      // Now the tool should be resolvable
      const after = await forgeRuntime.resolveTool("late-adder");
      expect(after).toBeDefined();
      expect(after?.descriptor.name).toBe("late-adder");

      // Wire into createKoi with forge runtime for hot-attach
      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You have a late-adder tool. Use it when asked to add numbers. Always use the tool.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const koiRuntime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: piAdapter,
        forge: forgeRuntime,
        loopDetection: false,
        limits: { maxTurns: 5, maxDurationMs: 60_000, maxTokens: 10_000 },
      });

      // LLM should be able to use the hot-attached tool
      const events = await collectEvents(
        koiRuntime.run({
          kind: "text",
          text: "Use the late-adder tool to add 100 and 200. Return ONLY the numeric result.",
        }),
      );
      await koiRuntime.dispose();
      forgeRuntime.dispose?.();

      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      // Verify tool was called
      const toolCalls = events.filter((e) => e.kind === "tool_call_start");
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);

      const text = extractText(events);
      expect(text).toContain("300");
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 6. Middleware chain intercepts forged tool calls
  // -------------------------------------------------------------------------

  test(
    "middleware spy intercepts forged tool calls through full runtime",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();

      const mwAdderImpl = "return { sum: input.a + input.b };";
      await store.save(
        createTestToolArtifact({
          id: computeBrickId("tool", mwAdderImpl),
          name: "mw-adder",
          description: "Adds two numbers. Call with {a, b}. Returns {sum}.",
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
          },
          implementation: mwAdderImpl,
        }),
      );

      const forgeProvider = createForgeComponentProvider({
        store,
        executor: mockTiered(executor),
      });

      // Middleware spy tracks intercepted tool calls
      const interceptedTools: string[] = [];
      const middlewareSpy: KoiMiddleware = {
        name: "e2e-tool-spy",
        describeCapabilities: () => undefined,
        wrapToolCall: async (_ctx, req: ToolRequest, next) => {
          interceptedTools.push(req.toolId);
          return next(req);
        },
      };

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You have an mw-adder tool. ALWAYS use it when asked to add. Never compute mentally.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: piAdapter,
        providers: [forgeProvider],
        middleware: [middlewareSpy],
        loopDetection: false,
        limits: { maxTurns: 5, maxDurationMs: 60_000, maxTokens: 10_000 },
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the mw-adder tool to add 3 and 4. Return ONLY the result.",
        }),
      );
      await runtime.dispose();

      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      // Middleware should have intercepted the tool call
      expect(interceptedTools).toContain("mw-adder");

      const text = extractText(events);
      expect(text).toContain("7");
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // 7. All 5 brick kinds attached in a single assembly pass
  // -------------------------------------------------------------------------

  test(
    "all 5 brick kinds attached in single assembly pass with correct tokens",
    async () => {
      const store = createInMemoryForgeStore();
      const executor = echoExecutor();

      // Save one of each kind (unique IDs to avoid store collisions)
      const echoImpl = "return input;";
      const mwImpl = "export function wrapModelCall(ctx, req, next) { return next(req); }";
      const chImpl = "export function send(msg) { return msg; }";
      const bricks: readonly BrickArtifact[] = [
        createTestToolArtifact({
          id: computeBrickId("tool", echoImpl),
          name: "echo-tool",
          description: "Echoes input",
          inputSchema: { type: "object" },
          implementation: echoImpl,
        }),
        createTestSkillArtifact({
          id: brickId("skill-writing"),
          name: "writing-skill",
          description: "Writing best practices",
          content: "# Writing\n\nBe concise.",
        }),
        createTestAgentArtifact({
          id: brickId("agent-editor"),
          name: "editor-agent",
          description: "Editor agent for prose",
          manifestYaml: "name: editor\nversion: 1.0.0",
        }),
        createTestImplementationArtifact({
          id: brickId("mw-logging"),
          name: "logging-mw",
          kind: "middleware",
          description: "Logging middleware",
          implementation: mwImpl,
          trustTier: "promoted",
        }),
        createTestImplementationArtifact({
          id: brickId("ch-slack"),
          name: "slack-channel",
          kind: "channel",
          description: "Slack channel adapter",
          implementation: chImpl,
          trustTier: "promoted",
        }),
      ];

      for (const brick of bricks) {
        await store.save(brick);
      }

      const forgeProvider = createForgeComponentProvider({
        store,
        executor: mockTiered(executor),
      });

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a test assistant. Reply with exactly: all-attached",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: E2E_MANIFEST,
        adapter: piAdapter,
        providers: [forgeProvider],
        loopDetection: false,
        limits: { maxTurns: 2, maxDurationMs: 30_000, maxTokens: 5_000 },
      });

      // Verify each kind is attached under correct token prefix
      const tool = runtime.agent.component(toolToken("echo-tool"));
      expect(tool).toBeDefined();

      const skills = runtime.agent.query<SkillComponent>("skill:");
      const writingSkill = skills.get(
        skillToken("writing-skill") as import("@koi/core").SubsystemToken<SkillComponent>,
      );
      expect(writingSkill).toBeDefined();
      expect(writingSkill?.content).toBe("# Writing\n\nBe concise.");

      const agents = runtime.agent.query<AgentDescriptor>("agent:");
      const editorAgent = agents.get(
        agentToken("editor-agent") as import("@koi/core").SubsystemToken<AgentDescriptor>,
      );
      expect(editorAgent).toBeDefined();
      expect(editorAgent?.manifestYaml).toContain("name: editor");

      // Middleware and channel are stored as raw ImplementationArtifact
      const mwComponents = runtime.agent.query("middleware:");
      expect(mwComponents.size).toBeGreaterThanOrEqual(1);

      const channelComponents = runtime.agent.query("channel:");
      expect(channelComponents.size).toBeGreaterThanOrEqual(1);

      // Run to prove assembly is valid
      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with: all-attached" }),
      );
      await runtime.dispose();

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(extractText(events).toLowerCase()).toContain("all-attached");
    },
    TIMEOUT_MS,
  );
});
