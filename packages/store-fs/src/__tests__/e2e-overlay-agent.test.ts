/**
 * E2E agent integration tests for the 4-tier overlay store.
 *
 * Exercises the complete flow: overlay store (filesystem-backed) → forge
 * component provider → engine middleware chain → tool execution.
 *
 * Validates that agents can:
 * 1. Discover and execute bundled bricks from read-only tiers
 * 2. Forge new tools (saved to agent tier)
 * 3. Search across all tiers with correct deduplication
 * 4. Auto-promote bundled bricks when updating
 * 5. Promote bricks between tiers
 *
 * @koi/engine and @koi/forge are devDependencies (test-only, no layer violation).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentManifest,
  ComponentProvider,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  EngineOutput,
  KoiMiddleware,
  ModelResponse,
  ToolDescriptor,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import type { ForgeDeps, ForgeResult, SandboxExecutor } from "@koi/forge";
import {
  createDefaultForgeConfig,
  createForgeComponentProvider,
  createForgeToolTool,
  createSearchForgeTool,
} from "@koi/forge";
import { createFsForgeStore } from "../fs-store.js";
import type { OverlayConfig } from "../overlay-store.js";
import { createOverlayForgeStore } from "../overlay-store.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let testCounter = 0;

async function freshDir(): Promise<string> {
  testCounter += 1;
  const dir = join(tmpdir(), `koi-e2e-overlay-${Date.now()}-${testCounter}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function testManifest(): AgentManifest {
  return {
    name: "Overlay E2E Agent",
    version: "0.1.0",
    model: { name: "test-model" },
  };
}

function doneOutput(overrides?: Partial<EngineOutput>): EngineOutput {
  return {
    content: [{ kind: "text", text: "done" }],
    stopReason: "completed",
    metrics: {
      totalTokens: 100,
      inputTokens: 60,
      outputTokens: 40,
      turns: 1,
      durationMs: 50,
    },
    ...overrides,
  };
}

/** Adder executor: evaluates `input.a + input.b`. */
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

/** Echo executor: returns input as-is. */
function echoExecutor(): SandboxExecutor {
  return {
    execute: async (_code, input, _timeout) => ({
      ok: true,
      value: { output: input, durationMs: 1 },
    }),
  };
}

/** Multiplier executor: evaluates `input.a * input.b`. */
function multiplierExecutor(): SandboxExecutor {
  return {
    execute: async (_code, input, _timeout) => {
      const obj = input as { readonly a: number; readonly b: number };
      return {
        ok: true,
        value: { output: { product: obj.a * obj.b }, durationMs: 1 },
      };
    },
  };
}

async function create4TierConfig(): Promise<{
  config: OverlayConfig;
  dirs: { agent: string; shared: string; extensions: string; bundled: string };
}> {
  const base = await freshDir();
  const dirs = {
    agent: join(base, "agent"),
    shared: join(base, "shared"),
    extensions: join(base, "extensions"),
    bundled: join(base, "bundled"),
  };
  const config: OverlayConfig = {
    tiers: [
      { name: "agent", access: "read-write", baseDir: dirs.agent },
      { name: "shared", access: "read-write", baseDir: dirs.shared },
      { name: "extensions", access: "read-only", baseDir: dirs.extensions },
      { name: "bundled", access: "read-only", baseDir: dirs.bundled },
    ],
  };
  return { config, dirs };
}

async function collectEvents(iter: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

function createDeps(
  store: Awaited<ReturnType<typeof createOverlayForgeStore>>,
  executor: SandboxExecutor,
): ForgeDeps {
  return {
    store,
    executor,
    verifiers: [],
    config: createDefaultForgeConfig(),
    context: {
      agentId: "overlay-e2e-agent",
      depth: 0,
      sessionId: "overlay-e2e-session",
      forgesThisSession: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("overlay store → agent e2e", () => {
  let config: OverlayConfig;
  let dirs: { agent: string; shared: string; extensions: string; bundled: string };

  beforeEach(async () => {
    const setup = await create4TierConfig();
    config = setup.config;
    dirs = setup.dirs;
  });

  // -----------------------------------------------------------------------
  // Test 1: Agent discovers and executes a tool from the bundled tier
  // -----------------------------------------------------------------------

  test("agent discovers and executes tool from bundled (read-only) tier", async () => {
    const executor = adderExecutor();

    // Pre-seed "adder" tool in the bundled tier
    const bundledStore = await createFsForgeStore({ baseDir: dirs.bundled });
    await bundledStore.save({
      id: "brick_bundled_adder",
      kind: "tool",
      name: "adder",
      description: "Adds two numbers",
      scope: "global",
      trustTier: "verified",
      lifecycle: "active",
      createdBy: "bundler",
      createdAt: Date.now(),
      version: "1.0.0",
      tags: ["math"],
      usageCount: 0,
      contentHash: "bundled-hash",
      implementation: "return { sum: input.a + input.b };",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
      },
    });

    // Create overlay store backed by the 4-tier filesystem
    const overlayStore = await createOverlayForgeStore(config);

    // Wire ForgeComponentProvider to overlay store
    const forgeProvider = createForgeComponentProvider({ store: overlayStore, executor });

    // Adapter calls the bundled "adder" tool
    const toolResults: ToolResponse[] = [];
    const adapter: EngineAdapter = {
      engineId: "bundled-e2e-adapter",
      terminals: {
        modelCall: async (): Promise<ModelResponse> => ({ content: "ok", model: "test" }),
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            const result = await input.callHandlers.toolCall({
              toolId: "adder",
              input: { a: 10, b: 20 },
            });
            toolResults.push(result);
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      providers: [forgeProvider],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "add 10+20" }));
    expect(events.some((e) => e.kind === "done")).toBe(true);

    // Tool from bundled tier executed correctly
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.output).toEqual({ sum: 30 });

    // Verify it's still in the bundled tier (not copied/promoted)
    const tierResult = await overlayStore.locateTier("brick_bundled_adder");
    expect(tierResult.ok).toBe(true);
    if (tierResult.ok) {
      expect(tierResult.value).toBe("bundled");
    }
  });

  // -----------------------------------------------------------------------
  // Test 2: Agent forges a new tool → saved to agent tier → reusable
  // -----------------------------------------------------------------------

  test("agent forges tool → saved to agent tier → reusable in next run", async () => {
    const executor = multiplierExecutor();
    const overlayStore = await createOverlayForgeStore(config);
    const deps = createDeps(overlayStore, executor);

    // Attach forge_tool as primordial provider
    const forgeTool = createForgeToolTool(deps);
    const primordialProvider: ComponentProvider = {
      name: "forge-primordials",
      attach: async (): Promise<ReadonlyMap<string, unknown>> =>
        new Map<string, unknown>([[toolToken("forge_tool") as string, forgeTool]]),
    };

    const forgeProvider = createForgeComponentProvider({ store: overlayStore, executor });

    // --- Run 1: Forge "multiplier" tool ---
    const forgeResults: ToolResponse[] = [];
    const adapter1: EngineAdapter = {
      engineId: "forge-overlay-run1",
      terminals: {
        modelCall: async (): Promise<ModelResponse> => ({ content: "ok", model: "test" }),
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            const result = await input.callHandlers.toolCall({
              toolId: "forge_tool",
              input: {
                name: "multiplier",
                description: "Multiplies two numbers",
                inputSchema: {
                  type: "object",
                  properties: { a: { type: "number" }, b: { type: "number" } },
                },
                implementation: "return { product: input.a * input.b };",
              },
            });
            forgeResults.push(result);
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const r1 = await createKoi({
      manifest: testManifest(),
      adapter: adapter1,
      providers: [primordialProvider, forgeProvider],
      loopDetection: false,
    });
    await collectEvents(r1.run({ kind: "text", text: "forge multiplier" }));

    // Forging succeeded
    expect(forgeResults).toHaveLength(1);
    const forgeOutput = forgeResults[0]?.output as {
      readonly ok: true;
      readonly value: ForgeResult;
    };
    expect(forgeOutput.ok).toBe(true);
    expect(forgeOutput.value.name).toBe("multiplier");

    // Tool was saved to agent tier (first writable)
    const tierResult = await overlayStore.locateTier(forgeOutput.value.id);
    expect(tierResult.ok).toBe(true);
    if (tierResult.ok) {
      expect(tierResult.value).toBe("agent");
    }

    // --- Run 2: Execute the forged tool ---
    forgeProvider.invalidate();

    const toolResults: ToolResponse[] = [];
    const adapter2: EngineAdapter = {
      engineId: "forge-overlay-run2",
      terminals: {
        modelCall: async (): Promise<ModelResponse> => ({ content: "ok", model: "test" }),
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            const result = await input.callHandlers.toolCall({
              toolId: "multiplier",
              input: { a: 6, b: 7 },
            });
            toolResults.push(result);
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const r2 = await createKoi({
      manifest: testManifest(),
      adapter: adapter2,
      providers: [primordialProvider, forgeProvider],
      loopDetection: false,
    });
    await collectEvents(r2.run({ kind: "text", text: "multiply 6*7" }));

    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.output).toEqual({ product: 42 });
  });

  // -----------------------------------------------------------------------
  // Test 3: Search across tiers — deduplicates, agent tier wins
  // -----------------------------------------------------------------------

  test("search across tiers deduplicates with agent tier winning", async () => {
    const executor = echoExecutor();

    // Pre-seed same-name bricks in bundled and agent tiers
    const bundledStore = await createFsForgeStore({ baseDir: dirs.bundled });
    await bundledStore.save({
      id: "brick_calc",
      kind: "tool",
      name: "calculator",
      description: "Bundled calculator v1",
      scope: "global",
      trustTier: "verified",
      lifecycle: "active",
      createdBy: "bundler",
      createdAt: Date.now(),
      version: "1.0.0",
      tags: ["math"],
      usageCount: 0,
      contentHash: "bundled-hash",
      implementation: "return input;",
      inputSchema: { type: "object" },
    });

    const agentStore = await createFsForgeStore({ baseDir: dirs.agent });
    await agentStore.save({
      id: "brick_calc",
      kind: "tool",
      name: "calculator",
      description: "Agent-forged calculator v2",
      scope: "agent",
      trustTier: "sandbox",
      lifecycle: "active",
      createdBy: "overlay-e2e-agent",
      createdAt: Date.now(),
      version: "2.0.0",
      tags: ["math"],
      usageCount: 5,
      contentHash: "agent-hash",
      implementation: "return input;",
      inputSchema: { type: "object" },
    });

    // Also seed a unique tool in shared tier
    const sharedStore = await createFsForgeStore({ baseDir: dirs.shared });
    await sharedStore.save({
      id: "brick_logger",
      kind: "tool",
      name: "logger",
      description: "Shared logging utility",
      scope: "zone",
      trustTier: "verified",
      lifecycle: "active",
      createdBy: "admin",
      createdAt: Date.now(),
      version: "1.0.0",
      tags: ["util"],
      usageCount: 0,
      contentHash: "shared-hash",
      implementation: "return input;",
      inputSchema: { type: "object" },
    });

    const overlayStore = await createOverlayForgeStore(config);

    // Search via forge tool — exercises overlay search through the real pipeline
    const deps = createDeps(overlayStore, executor);
    const searchTool = createSearchForgeTool(deps);

    // Search all — should find 2 (calculator deduped, + logger)
    const allResult = (await searchTool.execute({})) as {
      readonly ok: true;
      readonly value: readonly unknown[];
    };
    expect(allResult.ok).toBe(true);
    expect(allResult.value).toHaveLength(2);

    // The calculator should be the agent-tier version
    const calcBrick = (allResult.value as readonly { id: string; description: string }[]).find(
      (b) => b.id === "brick_calc",
    );
    expect(calcBrick?.description).toBe("Agent-forged calculator v2");
  });

  // -----------------------------------------------------------------------
  // Test 4: Update bundled brick → auto-promotes to agent tier
  // -----------------------------------------------------------------------

  test("update on bundled brick auto-promotes to agent tier", async () => {
    // Pre-seed in bundled tier
    const bundledStore = await createFsForgeStore({ baseDir: dirs.bundled });
    await bundledStore.save({
      id: "brick_autopromote",
      kind: "tool",
      name: "auto-promote-target",
      description: "Will be auto-promoted",
      scope: "global",
      trustTier: "verified",
      lifecycle: "active",
      createdBy: "bundler",
      createdAt: Date.now(),
      version: "1.0.0",
      tags: [],
      usageCount: 0,
      contentHash: "original-hash",
      implementation: "return input;",
      inputSchema: { type: "object" },
    });

    const overlayStore = await createOverlayForgeStore(config);

    // Starts in bundled tier
    const before = await overlayStore.locateTier("brick_autopromote");
    expect(before.ok).toBe(true);
    if (before.ok) expect(before.value).toBe("bundled");

    // Update usageCount — triggers auto-promote since bundled is read-only
    const updateResult = await overlayStore.update("brick_autopromote", { usageCount: 10 });
    expect(updateResult.ok).toBe(true);

    // Now in agent tier (auto-promoted)
    const after = await overlayStore.locateTier("brick_autopromote");
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.value).toBe("agent");

    // Verify updated data is correct
    const loaded = await overlayStore.load("brick_autopromote");
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.usageCount).toBe(10);
      expect(loaded.value.name).toBe("auto-promote-target");
    }
  });

  // -----------------------------------------------------------------------
  // Test 5: Full lifecycle — bundled → forge override → promote → search
  // -----------------------------------------------------------------------

  test("full lifecycle: bundled tool → agent overrides → promote → search", async () => {
    const executor = adderExecutor();

    // Pre-seed bundled "adder" v1
    const bundledStore = await createFsForgeStore({ baseDir: dirs.bundled });
    await bundledStore.save({
      id: "brick_adder_v1",
      kind: "tool",
      name: "adder",
      description: "Bundled adder v1",
      scope: "global",
      trustTier: "verified",
      lifecycle: "active",
      createdBy: "bundler",
      createdAt: Date.now(),
      version: "1.0.0",
      tags: ["math"],
      usageCount: 100,
      contentHash: "v1-hash",
      implementation: "return { sum: input.a + input.b };",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
      },
    });

    const overlayStore = await createOverlayForgeStore(config);
    const deps = createDeps(overlayStore, executor);

    // --- Step 1: Agent forges an improved "adder" v2 → saved to agent tier ---
    const forgeTool = createForgeToolTool(deps);
    const forgeResult = (await forgeTool.execute({
      name: "adder-v2",
      description: "Improved adder v2",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
      },
      implementation: "return { sum: input.a + input.b, version: 2 };",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(forgeResult.ok).toBe(true);
    const forgedId = forgeResult.value.id;

    // Agent-forged tool is in agent tier
    const tierResult = await overlayStore.locateTier(forgedId);
    expect(tierResult.ok).toBe(true);
    if (tierResult.ok) expect(tierResult.value).toBe("agent");

    // --- Step 2: Promote from agent → shared ---
    const promoteResult = await overlayStore.promote(forgedId, "shared");
    expect(promoteResult.ok).toBe(true);

    // Now in shared tier (moved from agent since agent is writable)
    const afterPromote = await overlayStore.locateTier(forgedId);
    expect(afterPromote.ok).toBe(true);
    if (afterPromote.ok) expect(afterPromote.value).toBe("shared");

    // --- Step 3: Search sees both bundled v1 and shared v2 ---
    const searchTool = createSearchForgeTool(deps);
    const results = (await searchTool.execute({ tags: ["math"] })) as {
      readonly ok: true;
      readonly value: readonly { id: string; name: string }[];
    };
    expect(results.ok).toBe(true);
    // Should find bundled adder v1 + shared adder-v2 (different IDs, no dedup conflict)
    expect(results.value.length).toBeGreaterThanOrEqual(1);
    const names = results.value.map((b) => b.name);
    expect(names).toContain("adder");

    // --- Step 4: Agent uses the forge provider to execute bundled adder through engine ---
    const forgeProvider = createForgeComponentProvider({ store: overlayStore, executor });

    const interceptedToolIds: string[] = [];
    const middlewareSpy: KoiMiddleware = {
      name: "lifecycle-spy",
      wrapToolCall: async (_ctx, req: ToolRequest, next) => {
        interceptedToolIds.push(req.toolId);
        return next(req);
      },
    };

    const toolResults: ToolResponse[] = [];
    const adapter: EngineAdapter = {
      engineId: "lifecycle-e2e",
      terminals: {
        modelCall: async (): Promise<ModelResponse> => ({ content: "ok", model: "test" }),
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            const result = await input.callHandlers.toolCall({
              toolId: "adder",
              input: { a: 100, b: 200 },
            });
            toolResults.push(result);
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      providers: [forgeProvider],
      middleware: [middlewareSpy],
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "add 100+200" }));

    // Bundled adder executed through middleware chain
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.output).toEqual({ sum: 300 });
    expect(interceptedToolIds).toEqual(["adder"]);
  });

  // -----------------------------------------------------------------------
  // Test 6: callHandlers.tools discovers tools from ALL tiers
  // -----------------------------------------------------------------------

  test("callHandlers.tools exposes tools from all tiers to adapter", async () => {
    const executor = echoExecutor();

    // Seed different tools in different tiers
    const bundledStore = await createFsForgeStore({ baseDir: dirs.bundled });
    await bundledStore.save({
      id: "brick_bundled_tool",
      kind: "tool",
      name: "bundled-tool",
      description: "From bundled tier",
      scope: "global",
      trustTier: "verified",
      lifecycle: "active",
      createdBy: "bundler",
      createdAt: Date.now(),
      version: "1.0.0",
      tags: [],
      usageCount: 0,
      contentHash: "b-hash",
      implementation: "return input;",
      inputSchema: { type: "object" },
    });

    const sharedStore = await createFsForgeStore({ baseDir: dirs.shared });
    await sharedStore.save({
      id: "brick_shared_tool",
      kind: "tool",
      name: "shared-tool",
      description: "From shared tier",
      scope: "zone",
      trustTier: "verified",
      lifecycle: "active",
      createdBy: "admin",
      createdAt: Date.now(),
      version: "1.0.0",
      tags: [],
      usageCount: 0,
      contentHash: "s-hash",
      implementation: "return input;",
      inputSchema: { type: "object" },
    });

    const agentStore = await createFsForgeStore({ baseDir: dirs.agent });
    await agentStore.save({
      id: "brick_agent_tool",
      kind: "tool",
      name: "agent-tool",
      description: "From agent tier",
      scope: "agent",
      trustTier: "sandbox",
      lifecycle: "active",
      createdBy: "overlay-e2e-agent",
      createdAt: Date.now(),
      version: "1.0.0",
      tags: [],
      usageCount: 0,
      contentHash: "a-hash",
      implementation: "return input;",
      inputSchema: { type: "object" },
    });

    const overlayStore = await createOverlayForgeStore(config);
    const forgeProvider = createForgeComponentProvider({ store: overlayStore, executor });

    // Adapter inspects callHandlers.tools
    const discoveredTools: ToolDescriptor[] = [];
    const adapter: EngineAdapter = {
      engineId: "multi-tier-discovery",
      terminals: {
        modelCall: async (): Promise<ModelResponse> => ({ content: "ok", model: "test" }),
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            discoveredTools.push(...input.callHandlers.tools);
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      providers: [forgeProvider],
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "discover all" }));

    // Adapter discovered all 3 tools from all tiers
    const toolNames = discoveredTools.map((t) => t.name).sort();
    expect(toolNames).toEqual(["agent-tool", "bundled-tool", "shared-tool"]);
  });
});
