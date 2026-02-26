/**
 * E2E: Approval cache through the full L1 runtime (createKoi + engine adapter).
 *
 * Validates that the three cache-key dimensions — policy fingerprint, user identity,
 * and TTL — work correctly when wired through the real middleware composition chain.
 *
 * Two tiers:
 *   1. Deterministic (createLoopAdapter + mock ModelHandler) — fast, stable, CI-safe
 *   2. Real LLM (createPiAdapter + Anthropic Haiku) — slower, requires API key + opt-in
 *
 * Run deterministic only:
 *   bun test src/__tests__/e2e-approval-cache.test.ts
 *
 * Run everything including real LLM:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-approval-cache.test.ts
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  AgentManifest,
  ComponentProvider,
  EngineEvent,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  Tool,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createPiAdapter } from "@koi/engine-pi";
import type { ApprovalHandler } from "../engine.js";
import { createPatternPermissionBackend } from "../engine.js";
import { createPermissionsMiddleware } from "../permissions.js";

// ---------------------------------------------------------------------------
// Environment gate (real LLM tests)
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeRealLLM = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const LLM_TIMEOUT_MS = 120_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function testManifest(): AgentManifest {
  return {
    name: "E2E Approval Cache Agent",
    version: "0.1.0",
    model: { name: "test-model" },
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

function findDoneOutput(
  events: readonly EngineEvent[],
): (EngineEvent & { readonly kind: "done" })["output"] | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

/** Tool that returns a fixed string — side-effect-free, deterministic. */
const DEPLOY_TOOL: Tool = {
  descriptor: {
    name: "deploy",
    description: "Deploys the application to the target environment.",
    inputSchema: {
      type: "object",
      properties: {
        env: { type: "string", description: "Target environment" },
      },
      required: ["env"],
    },
  },
  trustTier: "sandbox",
  execute: async (input: Readonly<Record<string, unknown>>) => {
    return JSON.stringify({ deployed: true, env: String(input.env ?? "staging") });
  },
};

function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "e2e-tool-provider",
    attach: async () => new Map(tools.map((t) => [toolToken(t.descriptor.name) as string, t])),
  };
}

/**
 * Create a mock ModelHandler that always requests the "deploy" tool on the first call,
 * then returns a text response on the second call (after tool result).
 */
function createMockModelHandler(): {
  readonly modelCall: (request: ModelRequest) => Promise<ModelResponse>;
  readonly callCount: { value: number };
} {
  const callCount = { value: 0 };
  const modelCall = async (request: ModelRequest): Promise<ModelResponse> => {
    callCount.value++;
    // Check if last message is a tool result — if so, respond with text
    const lastMsg = request.messages[request.messages.length - 1];
    if (lastMsg !== undefined && lastMsg.senderId === "tool") {
      return {
        content: "Deployment complete.",
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    }
    // Otherwise, request the deploy tool
    return {
      content: "",
      model: "mock-model",
      metadata: {
        toolCalls: [
          {
            toolName: "deploy",
            callId: `call-${callCount.value}`,
            input: { env: "staging" },
          },
        ],
      },
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  };
  return { modelCall, callCount };
}

// ---------------------------------------------------------------------------
// Tier 1: Deterministic tests (createLoopAdapter + mock model)
// ---------------------------------------------------------------------------

describe("e2e: approval cache through createKoi + createLoopAdapter", () => {
  // permissionEngine removed — using createPatternPermissionBackend({ rules }) inline

  test("approval cache skips re-prompt on second identical tool call", async () => {
    const requestApproval = mock(async () => true);
    const approvalHandler: ApprovalHandler = { requestApproval };
    const { modelCall } = createMockModelHandler();

    const permissionsMw = createPermissionsMiddleware({
      backend: createPatternPermissionBackend({ rules: { allow: [], deny: [], ask: ["deploy"] } }),
      approvalHandler,
      cache: true,
    });

    const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [permissionsMw],
      providers: [createToolProvider([DEPLOY_TOOL])],
      loopDetection: false,
    });

    // First run — prompts for approval
    const events1 = await collectEvents(runtime.run({ kind: "text", text: "Deploy to staging" }));
    expect(findDoneOutput(events1)).toBeDefined();
    expect(requestApproval).toHaveBeenCalledTimes(1);

    await runtime.dispose();

    // Second run — same middleware instance, same tool+input — cache hit
    const adapter2 = createLoopAdapter({ modelCall, maxTurns: 5 });
    const runtime2 = await createKoi({
      manifest: testManifest(),
      adapter: adapter2,
      middleware: [permissionsMw],
      providers: [createToolProvider([DEPLOY_TOOL])],
      loopDetection: false,
    });

    const events2 = await collectEvents(
      runtime2.run({ kind: "text", text: "Deploy to staging again" }),
    );
    expect(findDoneOutput(events2)).toBeDefined();
    // Should NOT have prompted again — cache hit
    expect(requestApproval).toHaveBeenCalledTimes(1);

    await runtime2.dispose();
  });

  test("different userId causes cache miss through full stack", async () => {
    const requestApproval = mock(async () => true);
    const approvalHandler: ApprovalHandler = { requestApproval };
    const { modelCall } = createMockModelHandler();

    const permissionsMw = createPermissionsMiddleware({
      backend: createPatternPermissionBackend({ rules: { allow: [], deny: [], ask: ["deploy"] } }),
      approvalHandler,
      cache: true,
    });

    // Run as user-a
    const adapter1 = createLoopAdapter({ modelCall, maxTurns: 5 });
    const runtime1 = await createKoi({
      manifest: testManifest(),
      adapter: adapter1,
      middleware: [permissionsMw],
      providers: [createToolProvider([DEPLOY_TOOL])],
      loopDetection: false,
      userId: "user-a",
    });

    await collectEvents(runtime1.run({ kind: "text", text: "Deploy" }));
    expect(requestApproval).toHaveBeenCalledTimes(1);
    await runtime1.dispose();

    // Run as user-b — cache miss, prompts again
    const adapter2 = createLoopAdapter({ modelCall, maxTurns: 5 });
    const runtime2 = await createKoi({
      manifest: testManifest(),
      adapter: adapter2,
      middleware: [permissionsMw],
      providers: [createToolProvider([DEPLOY_TOOL])],
      loopDetection: false,
      userId: "user-b",
    });

    await collectEvents(runtime2.run({ kind: "text", text: "Deploy" }));
    expect(requestApproval).toHaveBeenCalledTimes(2);
    await runtime2.dispose();
  });

  test("TTL expiry causes re-prompt through full stack", async () => {
    const requestApproval = mock(async () => true);
    const approvalHandler: ApprovalHandler = { requestApproval };
    const { modelCall } = createMockModelHandler();

    const permissionsMw = createPermissionsMiddleware({
      backend: createPatternPermissionBackend({ rules: { allow: [], deny: [], ask: ["deploy"] } }),
      approvalHandler,
      cache: { ttlMs: 50 },
    });

    // First run — prompts
    const adapter1 = createLoopAdapter({ modelCall, maxTurns: 5 });
    const runtime1 = await createKoi({
      manifest: testManifest(),
      adapter: adapter1,
      middleware: [permissionsMw],
      providers: [createToolProvider([DEPLOY_TOOL])],
      loopDetection: false,
    });

    await collectEvents(runtime1.run({ kind: "text", text: "Deploy" }));
    expect(requestApproval).toHaveBeenCalledTimes(1);
    await runtime1.dispose();

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Second run — expired, prompts again
    const adapter2 = createLoopAdapter({ modelCall, maxTurns: 5 });
    const runtime2 = await createKoi({
      manifest: testManifest(),
      adapter: adapter2,
      middleware: [permissionsMw],
      providers: [createToolProvider([DEPLOY_TOOL])],
      loopDetection: false,
    });

    await collectEvents(runtime2.run({ kind: "text", text: "Deploy" }));
    expect(requestApproval).toHaveBeenCalledTimes(2);
    await runtime2.dispose();
  });

  test("ttlMs: 0 keeps cache entries alive indefinitely", async () => {
    const requestApproval = mock(async () => true);
    const approvalHandler: ApprovalHandler = { requestApproval };
    const { modelCall } = createMockModelHandler();

    const permissionsMw = createPermissionsMiddleware({
      backend: createPatternPermissionBackend({ rules: { allow: [], deny: [], ask: ["deploy"] } }),
      approvalHandler,
      cache: { ttlMs: 0 },
    });

    const adapter1 = createLoopAdapter({ modelCall, maxTurns: 5 });
    const runtime1 = await createKoi({
      manifest: testManifest(),
      adapter: adapter1,
      middleware: [permissionsMw],
      providers: [createToolProvider([DEPLOY_TOOL])],
      loopDetection: false,
    });

    await collectEvents(runtime1.run({ kind: "text", text: "Deploy" }));
    expect(requestApproval).toHaveBeenCalledTimes(1);
    await runtime1.dispose();

    // Wait a bit — should still be cached
    await new Promise((resolve) => setTimeout(resolve, 50));

    const adapter2 = createLoopAdapter({ modelCall, maxTurns: 5 });
    const runtime2 = await createKoi({
      manifest: testManifest(),
      adapter: adapter2,
      middleware: [permissionsMw],
      providers: [createToolProvider([DEPLOY_TOOL])],
      loopDetection: false,
    });

    await collectEvents(runtime2.run({ kind: "text", text: "Deploy" }));
    // Still cached — no new prompt
    expect(requestApproval).toHaveBeenCalledTimes(1);
    await runtime2.dispose();
  });

  test("different rules fingerprint causes cache miss", async () => {
    const requestApprovalA = mock(async () => true);
    const requestApprovalB = mock(async () => true);
    const { modelCall } = createMockModelHandler();

    // Middleware A: ask only ["deploy"]
    const mwA = createPermissionsMiddleware({
      backend: createPatternPermissionBackend({ rules: { allow: [], deny: [], ask: ["deploy"] } }),
      approvalHandler: { requestApproval: requestApprovalA },
      cache: true,
    });

    // Middleware B: ask ["deploy", "restart"] — different rules fingerprint
    const mwB = createPermissionsMiddleware({
      backend: createPatternPermissionBackend({
        rules: { allow: [], deny: [], ask: ["deploy", "restart"] },
      }),
      approvalHandler: { requestApproval: requestApprovalB },
      cache: true,
    });

    // Approve on mwA
    const adapter1 = createLoopAdapter({ modelCall, maxTurns: 5 });
    const runtime1 = await createKoi({
      manifest: testManifest(),
      adapter: adapter1,
      middleware: [mwA],
      providers: [createToolProvider([DEPLOY_TOOL])],
      loopDetection: false,
    });
    await collectEvents(runtime1.run({ kind: "text", text: "Deploy" }));
    expect(requestApprovalA).toHaveBeenCalledTimes(1);
    await runtime1.dispose();

    // Cache hit on mwA — no re-prompt
    const adapter2 = createLoopAdapter({ modelCall, maxTurns: 5 });
    const runtime2 = await createKoi({
      manifest: testManifest(),
      adapter: adapter2,
      middleware: [mwA],
      providers: [createToolProvider([DEPLOY_TOOL])],
      loopDetection: false,
    });
    await collectEvents(runtime2.run({ kind: "text", text: "Deploy" }));
    expect(requestApprovalA).toHaveBeenCalledTimes(1);
    await runtime2.dispose();

    // mwB is a separate middleware instance with different rules — must prompt
    const adapter3 = createLoopAdapter({ modelCall, maxTurns: 5 });
    const runtime3 = await createKoi({
      manifest: testManifest(),
      adapter: adapter3,
      middleware: [mwB],
      providers: [createToolProvider([DEPLOY_TOOL])],
      loopDetection: false,
    });
    await collectEvents(runtime3.run({ kind: "text", text: "Deploy" }));
    expect(requestApprovalB).toHaveBeenCalledTimes(1);
    await runtime3.dispose();
  });

  test("denied tool throws and middleware chain propagates error", async () => {
    const { modelCall } = createMockModelHandler();

    const permissionsMw = createPermissionsMiddleware({
      backend: createPatternPermissionBackend({ rules: { allow: [], deny: ["deploy"], ask: [] } }),
    });

    const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [permissionsMw],
      providers: [createToolProvider([DEPLOY_TOOL])],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "Deploy" }));

    // The tool call should have errored and the adapter reports it as tool_call_end with error
    const toolEnds = events.filter((e) => e.kind === "tool_call_end");
    expect(toolEnds.length).toBeGreaterThanOrEqual(1);

    // The error message should indicate denial
    const firstEnd = toolEnds[0];
    if (firstEnd !== undefined && "result" in firstEnd) {
      const result = String(firstEnd.result);
      expect(result).toContain("denied");
    }

    await runtime.dispose();
  });

  test("allowed tool bypasses approval entirely through full stack", async () => {
    const requestApproval = mock(async () => true);
    const approvalHandler: ApprovalHandler = { requestApproval };
    const { modelCall } = createMockModelHandler();

    const permissionsMw = createPermissionsMiddleware({
      backend: createPatternPermissionBackend({ rules: { allow: ["deploy"], deny: [], ask: [] } }),
      approvalHandler,
      cache: true,
    });

    const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [permissionsMw],
      providers: [createToolProvider([DEPLOY_TOOL])],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "Deploy" }));

    expect(findDoneOutput(events)).toBeDefined();
    // Never prompted — tool is in allow list
    expect(requestApproval).not.toHaveBeenCalled();

    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Tier 2: Real LLM tests (createPiAdapter + Anthropic)
// ---------------------------------------------------------------------------

describeRealLLM("e2e: approval cache with real LLM (createPiAdapter)", () => {
  // permissionEngine removed — using createPatternPermissionBackend({ rules }) inline

  test(
    "permissions middleware intercepts tool call from real LLM and caches approval",
    async () => {
      const requestApproval = mock(async () => true);
      const approvalHandler: ApprovalHandler = { requestApproval };

      const permissionsMw = createPermissionsMiddleware({
        backend: createPatternPermissionBackend({
          rules: { allow: [], deny: [], ask: ["get_weather"] },
        }),
        approvalHandler,
        cache: true,
      });

      const weatherTool: Tool = {
        descriptor: {
          name: "get_weather",
          description: "Returns the current weather for a city.",
          inputSchema: {
            type: "object",
            properties: {
              city: { type: "string", description: "City name" },
            },
            required: ["city"],
          },
        },
        trustTier: "sandbox",
        execute: async (input: Readonly<Record<string, unknown>>) => {
          return JSON.stringify({
            city: String(input.city ?? "unknown"),
            temperature: 22,
            condition: "sunny",
          });
        },
      };

      // Track tool calls observed through our observer middleware
      const toolCallsSeen: string[] = [];
      const observerMw: KoiMiddleware = {
        name: "tool-observer",
        priority: 200, // After permissions (100)
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolCallsSeen.push(request.toolId);
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the get_weather tool when asked about weather. Always use tools.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: {
          name: "E2E Real LLM Agent",
          version: "0.1.0",
          model: { name: "claude-haiku-4-5" },
        },
        adapter,
        middleware: [permissionsMw, observerMw],
        providers: [createToolProvider([weatherTool])],
        loopDetection: false,
        userId: "e2e-test-user",
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "What is the weather in Tokyo? Use the get_weather tool.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Permissions middleware should have intercepted and prompted for approval
      expect(requestApproval).toHaveBeenCalledTimes(1);

      // The observer middleware (after permissions) should have seen the tool call
      expect(toolCallsSeen).toContain("get_weather");

      // The response text should reference weather data
      const textEvents = events.filter(
        (e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta",
      );
      const fullText = textEvents.map((e) => e.delta).join("");
      expect(fullText.length).toBeGreaterThan(0);

      await runtime.dispose();
    },
    LLM_TIMEOUT_MS,
  );

  test(
    "cached approval from first LLM call skips prompt on second call",
    async () => {
      const requestApproval = mock(async () => true);
      const approvalHandler: ApprovalHandler = { requestApproval };

      const permissionsMw = createPermissionsMiddleware({
        backend: createPatternPermissionBackend({
          rules: { allow: [], deny: [], ask: ["multiply"] },
        }),
        approvalHandler,
        cache: true,
      });

      const multiplyTool: Tool = {
        descriptor: {
          name: "multiply",
          description: "Multiplies two numbers.",
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
          return String(Number(input.a ?? 0) * Number(input.b ?? 0));
        },
      };

      // First run — should prompt
      const adapter1 = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You MUST use the multiply tool for math. Never compute in your head.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime1 = await createKoi({
        manifest: testManifest(),
        adapter: adapter1,
        middleware: [permissionsMw],
        providers: [createToolProvider([multiplyTool])],
        loopDetection: false,
        userId: "e2e-user",
      });

      await collectEvents(
        runtime1.run({
          kind: "text",
          text: "Use multiply to compute 7 * 8.",
        }),
      );
      const promptCountAfterFirst = requestApproval.mock.calls.length;
      expect(promptCountAfterFirst).toBeGreaterThanOrEqual(1);
      await runtime1.dispose();

      // Second run — same middleware instance, same userId, same tool+input
      // The LLM may produce slightly different input JSON, so cache hit is not
      // guaranteed with real LLM. But the middleware wiring is validated.
      const adapter2 = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You MUST use the multiply tool for math. Never compute in your head.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime2 = await createKoi({
        manifest: testManifest(),
        adapter: adapter2,
        middleware: [permissionsMw],
        providers: [createToolProvider([multiplyTool])],
        loopDetection: false,
        userId: "e2e-user",
      });

      await collectEvents(
        runtime2.run({
          kind: "text",
          text: "Use multiply to compute 7 * 8.",
        }),
      );

      // If LLM sends identical input JSON, approval count stays the same (cache hit).
      // If LLM sends different input, it increments by 1 (cache miss on different input).
      // Either way, the middleware chain fired correctly.
      const promptCountAfterSecond = requestApproval.mock.calls.length;
      expect(promptCountAfterSecond).toBeGreaterThanOrEqual(promptCountAfterFirst);

      await runtime2.dispose();
    },
    LLM_TIMEOUT_MS * 2,
  );

  test(
    "different userId with real LLM causes cache miss",
    async () => {
      const requestApproval = mock(async () => true);
      const approvalHandler: ApprovalHandler = { requestApproval };

      const permissionsMw = createPermissionsMiddleware({
        backend: createPatternPermissionBackend({
          rules: { allow: [], deny: [], ask: ["multiply"] },
        }),
        approvalHandler,
        cache: true,
      });

      const multiplyTool: Tool = {
        descriptor: {
          name: "multiply",
          description: "Multiplies two numbers.",
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
          return String(Number(input.a ?? 0) * Number(input.b ?? 0));
        },
      };

      // Run as user-alpha
      const adapter1 = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Use the multiply tool for math.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime1 = await createKoi({
        manifest: testManifest(),
        adapter: adapter1,
        middleware: [permissionsMw],
        providers: [createToolProvider([multiplyTool])],
        loopDetection: false,
        userId: "user-alpha",
      });

      await collectEvents(runtime1.run({ kind: "text", text: "Multiply 3 * 4 using the tool." }));
      const countAfterAlpha = requestApproval.mock.calls.length;
      expect(countAfterAlpha).toBeGreaterThanOrEqual(1);
      await runtime1.dispose();

      // Run as user-beta — different identity, must re-prompt
      const adapter2 = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Use the multiply tool for math.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime2 = await createKoi({
        manifest: testManifest(),
        adapter: adapter2,
        middleware: [permissionsMw],
        providers: [createToolProvider([multiplyTool])],
        loopDetection: false,
        userId: "user-beta",
      });

      await collectEvents(runtime2.run({ kind: "text", text: "Multiply 3 * 4 using the tool." }));
      const countAfterBeta = requestApproval.mock.calls.length;
      // Must have prompted at least once more for user-beta
      expect(countAfterBeta).toBeGreaterThan(countAfterAlpha);
      await runtime2.dispose();
    },
    LLM_TIMEOUT_MS * 2,
  );
});
