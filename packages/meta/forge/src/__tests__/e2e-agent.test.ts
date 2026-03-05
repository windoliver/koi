/**
 * E2E agent integration tests — exercises the complete flow:
 * forge tool → ForgeComponentProvider attaches it → cooperating adapter calls
 * the forged tool through the engine middleware chain → tool executes and returns.
 *
 * @koi/engine is a devDependency (test files aren't production code — no layer violation).
 */

import { describe, expect, test } from "bun:test";
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
import type { ForgeDeps } from "@koi/forge-tools";
import {
  createForgeComponentProvider,
  createForgeSkillTool,
  createForgeToolTool,
  createInMemoryForgeStore,
  createSearchForgeTool,
} from "@koi/forge-tools";
import type { BrickArtifact, ForgeResult, SandboxExecutor } from "@koi/forge-types";
import { createDefaultForgeConfig } from "@koi/forge-types";
import { createForgePipeline } from "../create-forge-stack.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function testManifest(): AgentManifest {
  return {
    name: "Forge E2E Agent",
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

/** Echo executor: returns input as-is (simulates `return input.a + input.b` without eval). */
function mockExecutor(): SandboxExecutor {
  return {
    execute: async (_code, input, _timeout) => ({
      ok: true,
      value: { output: input, durationMs: 1 },
    }),
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

function defaultDeps(
  store: ReturnType<typeof createInMemoryForgeStore>,
  executor: SandboxExecutor,
): ForgeDeps {
  return {
    store,
    executor: executor,
    verifiers: [],
    config: createDefaultForgeConfig(),
    context: {
      agentId: "e2e-agent",
      depth: 0,
      sessionId: "e2e-session",
      forgesThisSession: 0,
    },
    pipeline: createForgePipeline(),
  };
}

async function collectEvents(iter: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Test 1: Forge tool → agent executes forged tool through engine
// ---------------------------------------------------------------------------

describe("forge → agent e2e", () => {
  test("forge tool → agent executes forged tool through engine middleware chain", async () => {
    const store = createInMemoryForgeStore();
    const executor = adderExecutor();
    const deps = defaultDeps(store, executor);

    // Step 1: Forge an "adder" tool via the primordial tool API
    const forgeTool = createForgeToolTool(deps);
    const forgeResult = (await forgeTool.execute({
      name: "adder",
      description: "Adds two numbers",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
      },
      implementation: "return input.a + input.b;",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(forgeResult.ok).toBe(true);
    expect(forgeResult.value.name).toBe("adder");

    // Step 2: Create ForgeComponentProvider backed by the same store
    const forgeProvider = createForgeComponentProvider({ store, executor: executor });

    // Step 3: Build cooperating adapter that calls the forged tool
    // Local mutation acceptable: arrays are never exposed until test assertions
    const toolResults: ToolResponse[] = [];

    const adapter: EngineAdapter = {
      engineId: "forge-e2e-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: {
        modelCall: async (): Promise<ModelResponse> => ({
          content: "ok",
          model: "test",
        }),
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            const result = await input.callHandlers.toolCall({
              toolId: "adder",
              input: { a: 3, b: 4 },
            });
            toolResults.push(result);
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    // Step 4: Middleware spy — proves tool call flows through middleware chain
    const interceptedToolIds: string[] = [];
    const middlewareSpy: KoiMiddleware = {
      name: "e2e-spy",
      describeCapabilities: () => undefined,
      wrapToolCall: async (_ctx, req: ToolRequest, next) => {
        interceptedToolIds.push(req.toolId);
        return next(req);
      },
    };

    // Step 5: createKoi with forge provider + middleware spy
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      providers: [forgeProvider],
      middleware: [middlewareSpy],
      loopDetection: false,
    });

    // Step 6: Run and collect events
    const events = await collectEvents(runtime.run({ kind: "text", text: "add 3 + 4" }));

    // Step 7: Assertions
    expect(events.some((e) => e.kind === "done")).toBe(true);
    expect(runtime.agent.state).toBe("terminated");

    // Tool was called and returned the sum
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.output).toEqual({ sum: 7 });

    // Middleware spy confirms tool call flowed through the chain
    expect(interceptedToolIds).toEqual(["adder"]);

    // Agent has the tool component attached
    const toolComponent = runtime.agent.component(toolToken("adder"));
    expect(toolComponent).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Test 2: Agent calls non-existent forged tool → NOT_FOUND error
  // ---------------------------------------------------------------------------

  test("agent calls non-existent forged tool → NOT_FOUND error", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();

    // Forge one tool so the provider has something to load
    const deps = defaultDeps(store, executor);
    const forgeTool = createForgeToolTool(deps);
    await forgeTool.execute({
      name: "existing-tool",
      description: "A tool that exists",
      inputSchema: { type: "object" },
      implementation: "return input;",
    });

    const forgeProvider = createForgeComponentProvider({ store, executor: executor });

    const errors: unknown[] = [];

    const adapter: EngineAdapter = {
      engineId: "not-found-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: {
        modelCall: async (): Promise<ModelResponse> => ({
          content: "ok",
          model: "test",
        }),
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            try {
              await input.callHandlers.toolCall({
                toolId: "unknown-tool",
                input: {},
              });
            } catch (err: unknown) {
              errors.push(err);
            }
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

    await collectEvents(runtime.run({ kind: "text", text: "call unknown" }));

    expect(errors).toHaveLength(1);
    const error = errors[0] as Error;
    expect(error.message).toContain("unknown-tool");
    expect(error.message).toContain("not found");
  });

  // ---------------------------------------------------------------------------
  // Test 3: Forge invalidate → agent sees newly forged tools
  // ---------------------------------------------------------------------------

  test("invalidate cache → second run sees newly forged tool", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const deps = defaultDeps(store, executor);

    // Forge tool-1
    const forgeTool = createForgeToolTool(deps);
    await forgeTool.execute({
      name: "tool-1",
      description: "First tool",
      inputSchema: { type: "object" },
      implementation: "return input;",
    });

    const forgeProvider = createForgeComponentProvider({ store, executor: executor });

    // --- First run: tool-1 is available ---
    const firstResults: ToolResponse[] = [];
    const firstAdapter: EngineAdapter = {
      engineId: "first-run-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: {
        modelCall: async (): Promise<ModelResponse> => ({
          content: "ok",
          model: "test",
        }),
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            const result = await input.callHandlers.toolCall({
              toolId: "tool-1",
              input: { x: 1 },
            });
            firstResults.push(result);
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime1 = await createKoi({
      manifest: testManifest(),
      adapter: firstAdapter,
      providers: [forgeProvider],
      loopDetection: false,
    });

    await collectEvents(runtime1.run({ kind: "text", text: "run 1" }));
    expect(firstResults).toHaveLength(1);
    expect(firstResults[0]?.output).toEqual({ x: 1 });

    // --- Forge tool-2 into the store ---
    const deps2: ForgeDeps = {
      ...deps,
      context: { ...deps.context, forgesThisSession: 1 },
    };
    const forgeTool2 = createForgeToolTool(deps2);
    await forgeTool2.execute({
      name: "tool-2",
      description: "Second tool",
      inputSchema: { type: "object" },
      implementation: "return { ...input, tool: 2 };",
    });

    // Invalidate cache so next attach() re-queries the store
    forgeProvider.invalidate();

    // --- Second run: tool-2 is now available ---
    const secondResults: ToolResponse[] = [];
    const secondAdapter: EngineAdapter = {
      engineId: "second-run-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: {
        modelCall: async (): Promise<ModelResponse> => ({
          content: "ok",
          model: "test",
        }),
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            const result = await input.callHandlers.toolCall({
              toolId: "tool-2",
              input: { y: 2 },
            });
            secondResults.push(result);
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime2 = await createKoi({
      manifest: testManifest(),
      adapter: secondAdapter,
      providers: [forgeProvider],
      loopDetection: false,
    });

    await collectEvents(runtime2.run({ kind: "text", text: "run 2" }));
    expect(secondResults).toHaveLength(1);
    expect(secondResults[0]?.output).toEqual({ y: 2 });
  });
});

// ---------------------------------------------------------------------------
// Test 4: Search mixed types with text filter
// ---------------------------------------------------------------------------

describe("forge search e2e", () => {
  test("search mixed types with text filter", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const deps = defaultDeps(store, executor);

    // Forge tool "json-parser" (description: "parses JSON strings")
    const forgeTool = createForgeToolTool(deps);
    await forgeTool.execute({
      name: "json-parser",
      description: "parses JSON strings",
      inputSchema: { type: "object" },
      implementation: "return JSON.parse(input.raw);",
    });

    // Forge skill "json-guide" (description: "guide for JSON operations")
    const deps2: ForgeDeps = { ...deps, context: { ...deps.context, forgesThisSession: 1 } };
    const forgeSkill = createForgeSkillTool(deps2);
    await forgeSkill.execute({
      name: "json-guide",
      description: "guide for JSON operations",
      body: "# JSON Guide\n\nHow to work with JSON.",
    });

    const searchTool = createSearchForgeTool(deps);

    // search_forge({ text: "json" }) → finds both
    const jsonBricks = (await searchTool.execute({ text: "json" })) as {
      readonly ok: true;
      readonly value: readonly BrickArtifact[];
    };
    expect(jsonBricks.ok).toBe(true);
    expect(jsonBricks.value).toHaveLength(2);

    // search_forge({ text: "json", kind: "tool" }) → finds only tool
    const jsonTools = (await searchTool.execute({ text: "json", kind: "tool" })) as {
      readonly ok: true;
      readonly value: readonly BrickArtifact[];
    };
    expect(jsonTools.ok).toBe(true);
    expect(jsonTools.value).toHaveLength(1);
    expect(jsonTools.value[0]?.name).toBe("json-parser");

    // search_forge({ text: "json", kind: "skill" }) → finds only skill
    const jsonSkills = (await searchTool.execute({ text: "json", kind: "skill" })) as {
      readonly ok: true;
      readonly value: readonly BrickArtifact[];
    };
    expect(jsonSkills.ok).toBe(true);
    expect(jsonSkills.value).toHaveLength(1);
    expect(jsonSkills.value[0]?.name).toBe("json-guide");
  });
});

// ---------------------------------------------------------------------------
// Test 5: callHandlers.tools contains forged tool descriptors
// ---------------------------------------------------------------------------

describe("forge → callHandlers.tools visibility", () => {
  test("callHandlers.tools exposes forged tool descriptors to adapter", async () => {
    const store = createInMemoryForgeStore();
    const executor = adderExecutor();
    const deps = defaultDeps(store, executor);

    // Forge an "adder" tool
    const forgeTool = createForgeToolTool(deps);
    await forgeTool.execute({
      name: "adder",
      description: "Adds two numbers",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
      },
      implementation: "return input.a + input.b;",
    });

    const forgeProvider = createForgeComponentProvider({ store, executor: executor });

    // Adapter inspects callHandlers.tools to discover available tools
    const discoveredTools: readonly ToolDescriptor[] = [];
    const adapter: EngineAdapter = {
      engineId: "tools-visibility-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: {
        modelCall: async (): Promise<ModelResponse> => ({
          content: "ok",
          model: "test",
        }),
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            // Read the tools list — this is what pi-agent-core uses
            (discoveredTools as ToolDescriptor[]).push(...input.callHandlers.tools);
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

    await collectEvents(runtime.run({ kind: "text", text: "discover" }));

    // Adapter saw the forged tool descriptor
    expect(discoveredTools).toHaveLength(1);
    expect(discoveredTools[0]?.name).toBe("adder");
    expect(discoveredTools[0]?.description).toBe("Adds two numbers");
    expect(discoveredTools[0]?.inputSchema).toEqual({
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
    });
  });
});

// ---------------------------------------------------------------------------
// Test 6: Agent forges a tool at runtime, then reuses it in a second run
// ---------------------------------------------------------------------------

describe("forge → reuse: agent self-extends", () => {
  /**
   * Simulates the full lifecycle:
   *   Run 1: Agent has forge_tool → calls it to create "adder" → saved to store
   *   Run 2: Agent sees "adder" in callHandlers.tools → calls it → gets result
   *
   * This proves the pi-agent (or any adapter) can forge tools on the fly
   * and reuse them in subsequent runs.
   */
  test("agent forges tool in run 1, reuses it in run 2 via callHandlers.tools", async () => {
    const store = createInMemoryForgeStore();
    const executor = adderExecutor();
    const deps = defaultDeps(store, executor);

    // Attach forge_tool as an agent component (simulates how primordial tools
    // would be registered in production via a ComponentProvider)
    const forgeTool = createForgeToolTool(deps);
    const primordialProvider: ComponentProvider = {
      name: "forge-primordials",
      attach: async (): Promise<ReadonlyMap<string, unknown>> => {
        return new Map<string, unknown>([[toolToken("forge_tool") as string, forgeTool]]);
      },
    };

    // ForgeComponentProvider loads forged tools from the store
    const forgeProvider = createForgeComponentProvider({ store, executor: executor });

    // --- Run 1: Adapter discovers forge_tool and uses it to forge "adder" ---
    const run1ToolNames: string[] = [];
    const forgeResults: ToolResponse[] = [];

    const adapter1: EngineAdapter = {
      engineId: "self-extend-run1",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: {
        modelCall: async (): Promise<ModelResponse> => ({
          content: "ok",
          model: "test",
        }),
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            // Record what tools the adapter can see
            for (const t of input.callHandlers.tools) {
              run1ToolNames.push(t.name);
            }

            // Call forge_tool to create "adder"
            const result = await input.callHandlers.toolCall({
              toolId: "forge_tool",
              input: {
                name: "adder",
                description: "Adds two numbers",
                inputSchema: {
                  type: "object",
                  properties: { a: { type: "number" }, b: { type: "number" } },
                },
                implementation: "return { sum: input.a + input.b };",
              },
            });
            forgeResults.push(result);
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime1 = await createKoi({
      manifest: testManifest(),
      adapter: adapter1,
      providers: [primordialProvider, forgeProvider],
      loopDetection: false,
    });

    await collectEvents(runtime1.run({ kind: "text", text: "forge adder" }));

    // Run 1 assertions: adapter saw forge_tool, forging succeeded
    expect(run1ToolNames).toContain("forge_tool");
    expect(run1ToolNames).not.toContain("adder"); // not forged yet at start
    expect(forgeResults).toHaveLength(1);
    const forgeOutput = forgeResults[0]?.output as {
      readonly ok: true;
      readonly value: ForgeResult;
    };
    expect(forgeOutput.ok).toBe(true);
    expect(forgeOutput.value.name).toBe("adder");

    // --- Invalidate forge provider cache so it re-queries the store ---
    forgeProvider.invalidate();

    // --- Run 2: Adapter now sees "adder" in callHandlers.tools and calls it ---
    const run2ToolNames: string[] = [];
    const adderResults: ToolResponse[] = [];

    const adapter2: EngineAdapter = {
      engineId: "self-extend-run2",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: {
        modelCall: async (): Promise<ModelResponse> => ({
          content: "ok",
          model: "test",
        }),
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            // Record visible tools
            for (const t of input.callHandlers.tools) {
              run2ToolNames.push(t.name);
            }

            // Call the forged adder tool
            const result = await input.callHandlers.toolCall({
              toolId: "adder",
              input: { a: 10, b: 7 },
            });
            adderResults.push(result);
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime2 = await createKoi({
      manifest: testManifest(),
      adapter: adapter2,
      providers: [primordialProvider, forgeProvider],
      loopDetection: false,
    });

    await collectEvents(runtime2.run({ kind: "text", text: "add 10+7" }));

    // Run 2 assertions: adapter sees both forge_tool AND adder
    expect(run2ToolNames).toContain("forge_tool");
    expect(run2ToolNames).toContain("adder");

    // Adder tool was called and returned the sum
    expect(adderResults).toHaveLength(1);
    expect(adderResults[0]?.output).toEqual({ sum: 17 });
  });

  test("middleware intercepts both forge and forged tool calls", async () => {
    const store = createInMemoryForgeStore();
    const executor = adderExecutor();
    const deps = defaultDeps(store, executor);

    const forgeTool = createForgeToolTool(deps);
    const primordialProvider: ComponentProvider = {
      name: "forge-primordials",
      attach: async (): Promise<ReadonlyMap<string, unknown>> =>
        new Map<string, unknown>([[toolToken("forge_tool") as string, forgeTool]]),
    };
    const forgeProvider = createForgeComponentProvider({ store, executor: executor });

    // Middleware spy — records all tool calls through the chain
    const interceptedToolIds: string[] = [];
    const middlewareSpy: KoiMiddleware = {
      name: "tool-spy",
      describeCapabilities: () => undefined,
      wrapToolCall: async (_ctx, req: ToolRequest, next) => {
        interceptedToolIds.push(req.toolId);
        return next(req);
      },
    };

    // Run 1: Forge adder
    const forgeAdapter: EngineAdapter = {
      engineId: "mw-spy-run1",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: {
        modelCall: async (): Promise<ModelResponse> => ({ content: "ok", model: "test" }),
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            await input.callHandlers.toolCall({
              toolId: "forge_tool",
              input: {
                name: "adder",
                description: "Adds two numbers",
                inputSchema: {
                  type: "object",
                  properties: { a: { type: "number" }, b: { type: "number" } },
                },
                implementation: "return { sum: input.a + input.b };",
              },
            });
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const r1 = await createKoi({
      manifest: testManifest(),
      adapter: forgeAdapter,
      providers: [primordialProvider, forgeProvider],
      middleware: [middlewareSpy],
      loopDetection: false,
    });
    await collectEvents(r1.run({ kind: "text", text: "forge" }));
    expect(interceptedToolIds).toEqual(["forge_tool"]);

    // Invalidate + run 2: call forged tool
    forgeProvider.invalidate();
    interceptedToolIds.length = 0;

    const useAdapter: EngineAdapter = {
      engineId: "mw-spy-run2",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: {
        modelCall: async (): Promise<ModelResponse> => ({ content: "ok", model: "test" }),
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            await input.callHandlers.toolCall({
              toolId: "adder",
              input: { a: 5, b: 3 },
            });
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const r2 = await createKoi({
      manifest: testManifest(),
      adapter: useAdapter,
      providers: [primordialProvider, forgeProvider],
      middleware: [middlewareSpy],
      loopDetection: false,
    });
    await collectEvents(r2.run({ kind: "text", text: "use adder" }));

    // Middleware saw the forged tool call
    expect(interceptedToolIds).toEqual(["adder"]);
  });
});

// ---------------------------------------------------------------------------
// Test 7: Hot-attach — agent forges tool mid-session, visible in next turn
// ---------------------------------------------------------------------------

describe("forge → hot-attach: mid-session tool visibility", () => {
  test("agent forges tool mid-session, tool visible in next turn without restart", async () => {
    const store = createInMemoryForgeStore();
    const executor = adderExecutor();
    const deps = defaultDeps(store, executor);

    // Attach forge_tool as primordial
    const forgeTool = createForgeToolTool(deps);
    const primordialProvider: ComponentProvider = {
      name: "forge-primordials",
      attach: async (): Promise<ReadonlyMap<string, unknown>> =>
        new Map<string, unknown>([[toolToken("forge_tool") as string, forgeTool]]),
    };

    // Create ForgeRuntime (not ForgeComponentProvider) — enables hot-attach
    const { createForgeRuntime } = await import("../forge-runtime.js");
    const forgeRuntime = createForgeRuntime({
      store,
      executor: executor,
    });

    // Multi-turn adapter:
    // Turn 0: calls forge_tool to create "adder"
    // Turn 1: reads callHandlers.tools (should see "adder") and calls it
    const turn0ToolNames: string[] = [];
    const turn1ToolNames: string[] = [];
    const adderResults: unknown[] = [];

    const adapter: EngineAdapter = {
      engineId: "hot-attach-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: {
        modelCall: async (): Promise<ModelResponse> => ({
          content: "ok",
          model: "test",
        }),
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (!input.callHandlers) {
            yield { kind: "done" as const, output: doneOutput() };
            return;
          }

          // --- Turn 0: forge "adder" ---
          for (const t of input.callHandlers.tools) {
            turn0ToolNames.push(t.name);
          }

          await input.callHandlers.toolCall({
            toolId: "forge_tool",
            input: {
              name: "adder",
              description: "Adds two numbers",
              inputSchema: {
                type: "object",
                properties: { a: { type: "number" }, b: { type: "number" } },
              },
              implementation: "return { sum: input.a + input.b };",
            },
          });

          // Wait for store onChange → forgeRuntime cache invalidation + eager descriptor refresh
          await new Promise((r) => setTimeout(r, 100));

          yield { kind: "turn_end" as const, turnIndex: 0 };

          // --- Turn 1: "adder" should now be visible ---
          for (const t of input.callHandlers.tools) {
            turn1ToolNames.push(t.name);
          }

          // Call the forged adder tool
          const result = await input.callHandlers.toolCall({
            toolId: "adder",
            input: { a: 10, b: 7 },
          });
          adderResults.push(result.output);

          yield {
            kind: "done" as const,
            output: doneOutput({
              metrics: {
                totalTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
                turns: 2,
                durationMs: 0,
              },
            }),
          };
        },
      }),
    };

    // Single createKoi, single run — no invalidate(), no restart
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      providers: [primordialProvider],
      forge: forgeRuntime,
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "forge and use" }));

    // Assertions
    expect(events.some((e) => e.kind === "done")).toBe(true);

    // Turn 0: "adder" was NOT in the tool list (hasn't been forged yet)
    expect(turn0ToolNames).toContain("forge_tool");
    expect(turn0ToolNames).not.toContain("adder");

    // Turn 1: "adder" IS in the tool list (hot-attached via onChange)
    expect(turn1ToolNames).toContain("forge_tool");
    expect(turn1ToolNames).toContain("adder");

    // Adder was callable and returned correct result
    expect(adderResults).toHaveLength(1);
    expect(adderResults[0]).toEqual({ sum: 17 });
  });
});
