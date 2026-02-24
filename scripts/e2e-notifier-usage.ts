#!/usr/bin/env bun
/**
 * E2E test script for StoreChangeNotifier + ForgeUsageMiddleware — validates
 * the full notification and usage tracking pipeline.
 *
 * When ANTHROPIC_API_KEY is set, tests 1 and 4 use real Claude API calls to
 * forge and promote bricks. Otherwise, tools are called directly (still
 * exercises the full notifier + middleware pipeline).
 *
 * Tests:
 *  1. Forge a tool → notifier fires "saved" event
 *  2. ForgeComponentProvider auto-invalidates on "saved" event
 *  3. Execute forged tool through usage middleware → usage count incremented
 *  4. Promote a brick → notifier fires event
 *  5. Auto-promotion via usage threshold → trust tier upgrades
 *  6. Cross-agent invalidation: two providers share one notifier
 *  7. lookupBrickId resolves tool names after attach
 *  8. dispose() unsubscribes provider from notifier
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-notifier-usage.ts   # full mode
 *   bun scripts/e2e-notifier-usage.ts                             # local mode
 */

import type { StoreChangeEvent, ToolRequest, ToolResponse, TurnContext } from "@koi/core";
import { createDefaultForgeConfig } from "../packages/forge/src/config.js";
import { createForgeComponentProvider } from "../packages/forge/src/forge-component-provider.js";
import { createForgeUsageMiddleware } from "../packages/forge/src/forge-usage-middleware.js";
import { createInMemoryForgeStore } from "../packages/forge/src/memory-store.js";
import { createMemoryStoreChangeNotifier } from "../packages/forge/src/store-notifier.js";
import { createForgeToolTool } from "../packages/forge/src/tools/forge-tool.js";
import { createPromoteForgeTool } from "../packages/forge/src/tools/promote-forge.js";
import { createSearchForgeTool } from "../packages/forge/src/tools/search-forge.js";
import type { ForgeDeps } from "../packages/forge/src/tools/shared.js";
import type {
  ForgeResult,
  SandboxExecutor,
  TieredSandboxExecutor,
} from "../packages/forge/src/types.js";
import { recordBrickUsage } from "../packages/forge/src/usage.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
const USE_CLAUDE = API_KEY !== undefined && API_KEY.length > 0;

console.log("[e2e] Starting notifier + usage middleware E2E tests...");
console.log(`[e2e] Mode: ${USE_CLAUDE ? "FULL (with Claude API)" : "LOCAL (direct tool calls)"}\n`);

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

interface TestResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

const results: TestResult[] = [];

function assert(name: string, condition: boolean, detail?: string): void {
  results.push({ name, passed: condition, detail });
  const tag = condition ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  const suffix = detail && !condition ? ` — ${detail}` : "";
  console.log(`  ${tag}  ${name}${suffix}`);
}

// ---------------------------------------------------------------------------
// Shared setup: store, notifier, executor, config
// ---------------------------------------------------------------------------

const store = createInMemoryForgeStore();
const notifier = createMemoryStoreChangeNotifier();

// Collect all notifier events for assertion
const allEvents: StoreChangeEvent[] = [];
notifier.subscribe((event) => allEvents.push(event));

/** Eval executor — runs forged code via `new Function()`. */
const executor: SandboxExecutor = {
  execute: async (code, input, _timeout) => {
    try {
      const fn = new Function("input", code) as (input: unknown) => unknown;
      const output = fn(input);
      return { ok: true as const, value: { output, durationMs: 1 } };
    } catch (err: unknown) {
      return {
        ok: false as const,
        error: {
          code: "CRASH" as const,
          message: err instanceof Error ? err.message : String(err),
          durationMs: 1,
        },
      };
    }
  },
};

const tieredExecutor: TieredSandboxExecutor = {
  forTier: (tier) => ({
    executor,
    requestedTier: tier,
    resolvedTier: tier,
    fallback: false,
  }),
};

const config = createDefaultForgeConfig({
  maxForgesPerSession: 50,
  autoPromotion: {
    enabled: true,
    sandboxToVerifiedThreshold: 3,
    verifiedToPromotedThreshold: 10,
  },
});

let forgesThisSession = 0;

function makeDeps(overrides?: Partial<ForgeDeps>): ForgeDeps {
  return {
    store,
    executor: tieredExecutor,
    verifiers: [],
    config,
    context: {
      agentId: "e2e-notifier-agent",
      depth: 0,
      sessionId: `e2e-${Date.now()}`,
      forgesThisSession,
    },
    notifier,
    ...overrides,
  };
}

// Stub TurnContext for middleware calls
function stubTurnContext(): TurnContext {
  return {
    session: {
      agentId: "e2e-notifier-agent",
      sessionId: "sess_e2e" as TurnContext["session"]["sessionId"],
      runId: "run_e2e" as TurnContext["session"]["runId"],
      metadata: {},
    },
    turnIndex: 0,
    turnId: "turn_e2e" as TurnContext["turnId"],
    messages: [],
    metadata: {},
  };
}

// Stub Agent for provider.attach()
function stubAgent(): {
  readonly id: string;
  readonly state: "running";
  readonly component: () => undefined;
  readonly componentKeys: () => readonly never[];
  readonly setComponent: () => void;
  readonly metadata: Record<string, never>;
} {
  return {
    id: "test-agent",
    state: "running" as const,
    component: () => undefined,
    componentKeys: () => [],
    setComponent: () => {},
    metadata: {},
  };
}

// Create tools with notifier wired in
const forgeTool = createForgeToolTool(makeDeps());
const searchTool = createSearchForgeTool(makeDeps());
const promoteTool = createPromoteForgeTool(makeDeps());

// Tool registry for Claude agent loop
const TOOLS: Readonly<
  Record<
    string,
    {
      readonly descriptor: {
        readonly name: string;
        readonly description: string;
        readonly inputSchema: unknown;
      };
      readonly execute: (input: Record<string, unknown>) => Promise<unknown>;
    }
  >
> = {
  forge_tool: forgeTool,
  search_forge: searchTool,
  promote_forge: promoteTool,
};

// ---------------------------------------------------------------------------
// Claude API interaction (only used when API_KEY is set)
// ---------------------------------------------------------------------------

interface ContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
}

interface ApiMessage {
  readonly role: "user" | "assistant";
  readonly content: string | readonly ContentBlock[];
}

interface ApiResponse {
  readonly id: string;
  readonly content: readonly ContentBlock[];
  readonly stop_reason: string;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

const MODEL = "claude-sonnet-4-5-20250929";

async function callClaude(
  messages: readonly ApiMessage[],
  systemPrompt: string,
): Promise<ApiResponse> {
  if (!USE_CLAUDE) throw new Error("callClaude requires ANTHROPIC_API_KEY");

  const toolDefs = Object.values(TOOLS).map((t) => ({
    name: t.descriptor.name,
    description: t.descriptor.description,
    input_schema: t.descriptor.inputSchema,
  }));

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      tools: toolDefs,
      messages,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Claude API error (${response.status}): ${body}`);
  }

  return response.json() as Promise<ApiResponse>;
}

async function runAgentLoop(
  userMessage: string,
  systemPrompt: string,
  maxTurns = 5,
): Promise<{
  readonly toolCalls: readonly { readonly name: string; readonly result: unknown }[];
  readonly finalText: string;
}> {
  const messages: ApiMessage[] = [{ role: "user", content: userMessage }];
  const toolCalls: { name: string; result: unknown }[] = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await callClaude(messages, systemPrompt);

    const toolUseBlocks = response.content.filter(
      (
        b,
      ): b is ContentBlock & {
        readonly type: "tool_use";
        readonly id: string;
        readonly name: string;
        readonly input: Record<string, unknown>;
      } => b.type === "tool_use",
    );

    if (toolUseBlocks.length === 0) {
      const textBlock = response.content.find((b) => b.type === "text");
      return { toolCalls, finalText: textBlock?.text ?? "" };
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: ContentBlock[] = [];
    for (const block of toolUseBlocks) {
      const tool = TOOLS[block.name];
      let result: unknown;
      if (tool !== undefined) {
        try {
          result = await tool.execute(block.input);
          forgesThisSession++;
        } catch (err: unknown) {
          result = {
            ok: false,
            error: { message: err instanceof Error ? err.message : String(err) },
          };
        }
      } else {
        result = { ok: false, error: { message: `Unknown tool: ${block.name}` } };
      }

      toolCalls.push({ name: block.name, result });
      toolResults.push({
        type: "tool_result",
        // @ts-expect-error — tool_result content block has tool_use_id
        tool_use_id: block.id,
        // @ts-expect-error — tool_result content block has content string
        content: JSON.stringify(result),
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return { toolCalls, finalText: "(max turns reached)" };
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// System prompt (for Claude mode)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a tool-forging agent. You have access to 3 forge tools:

1. forge_tool — Creates a new executable tool. Requires: name (string, 3-50 chars, alphanumeric/dash/underscore, starts with letter), description (string), inputSchema (object with "type" field), implementation (string of JS code). IMPORTANT: The implementation is tested with an empty {} input — it MUST handle missing fields gracefully (use defaults, null checks, or optional chaining). Example: "const text = input.text || ''; return { result: text.split('').reverse().join('') };"
2. search_forge — Searches existing bricks. Optional fields: kind, scope, tags, text, limit.
3. promote_forge — Promotes a brick's scope/trust/lifecycle. Requires: brickId (string). Plus at least one of: targetScope, targetTrustTier, targetLifecycle.

IMPORTANT rules for names: must be 3-50 chars, start with a letter, only alphanumeric/dash/underscore. No spaces.

When asked to forge something, call the appropriate tool with valid arguments. Be precise with field names and types.`;

// ---------------------------------------------------------------------------
// Test 1: Forge a tool → notifier fires "saved" event
// ---------------------------------------------------------------------------

console.log("[test 1] Forge a tool → notifier fires 'saved' event");

let forgedBrickId: string | undefined;
const eventCountBefore = allEvents.length;

try {
  if (USE_CLAUDE) {
    // Full mode: Claude decides what arguments to pass
    const { toolCalls } = await withTimeout(
      () =>
        runAgentLoop(
          "Forge a tool called 'counter' that counts characters in a string. The implementation must handle empty input gracefully. Use: const text = input.text || ''; return { count: text.length }; — the inputSchema should accept a 'text' string field.",
          SYSTEM_PROMPT,
        ),
      60_000,
      "Test 1",
    );

    const forgeCall = toolCalls.find((c) => c.name === "forge_tool");
    assert("Claude called forge_tool", forgeCall !== undefined);

    if (forgeCall !== undefined) {
      const result = forgeCall.result as { readonly ok: boolean; readonly value?: ForgeResult };
      assert("forge_tool succeeded", result.ok === true, JSON.stringify(result).slice(0, 200));
      if (result.ok && result.value !== undefined) {
        forgedBrickId = result.value.id;
      }
    }
  } else {
    // Local mode: forge directly
    const result = (await forgeTool.execute({
      name: "counter",
      description: "Counts characters in a string",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      implementation: "const text = input.text || ''; return { count: text.length };",
    })) as { readonly ok: boolean; readonly value?: ForgeResult };

    assert("forge_tool succeeded", result.ok === true, JSON.stringify(result).slice(0, 200));
    if (result.ok && result.value !== undefined) {
      forgedBrickId = result.value.id;
    }
  }

  assert("forged tool has brick ID", forgedBrickId !== undefined);
  if (forgedBrickId !== undefined) {
    console.log(`    Brick ID: ${forgedBrickId}`);
  }

  // Allow fire-and-forget notifications to settle
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Verify "saved" event was fired
  const savedEvents = allEvents.filter((e, i) => i >= eventCountBefore && e.kind === "saved");
  assert(
    "notifier fired 'saved' event after forge",
    savedEvents.length >= 1,
    `got ${savedEvents.length} saved events`,
  );

  if (savedEvents.length >= 1 && forgedBrickId !== undefined) {
    assert(
      "'saved' event has correct brickId",
      savedEvents.some((e) => e.brickId === forgedBrickId),
    );
  }
} catch (err: unknown) {
  assert("Test 1 completed", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 2: ForgeComponentProvider auto-invalidates on "saved" event
// ---------------------------------------------------------------------------

console.log("\n[test 2] ForgeComponentProvider auto-invalidates on 'saved' event");

try {
  // Create provider with notifier subscription
  const provider = createForgeComponentProvider({
    store,
    executor: tieredExecutor,
    notifier,
  });

  // First attach — loads the forged "counter" tool
  const components1 = await provider.attach(stubAgent());
  assert(
    "provider found forged tool on first attach",
    components1.size >= 1,
    `found ${components1.size} tools`,
  );

  // Forge a second tool — notifier should auto-invalidate the provider
  const deps2 = makeDeps({
    context: {
      agentId: "e2e-notifier-agent",
      depth: 0,
      sessionId: `e2e-${Date.now()}`,
      forgesThisSession: 1,
    },
  });
  const forgeTool2 = createForgeToolTool(deps2);
  await forgeTool2.execute({
    name: "doubler",
    description: "Doubles a number",
    inputSchema: { type: "object", properties: { n: { type: "number" } } },
    implementation: "const n = input.n || 0; return { doubled: n * 2 };",
  });

  await new Promise((resolve) => setTimeout(resolve, 100));

  // Second attach — should see the new tool (cache was auto-invalidated by notifier)
  const components2 = await provider.attach(stubAgent());
  assert(
    "provider sees new tool after notifier invalidation",
    components2.size >= 2,
    `found ${components2.size} tools (expected >= 2)`,
  );

  provider.dispose();
} catch (err: unknown) {
  assert("Test 2 completed", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 3: Usage middleware records usage + fires "updated" notification
// ---------------------------------------------------------------------------

console.log("\n[test 3] Usage middleware records usage + fires 'updated' notification");

try {
  if (forgedBrickId === undefined) {
    assert("Test 3 requires forged brick", false, "no brick from test 1");
  } else {
    const provider = createForgeComponentProvider({
      store,
      executor: tieredExecutor,
      notifier,
    });

    // Attach to populate lookupBrickId map
    await provider.attach(stubAgent());

    // Create usage middleware with notifier
    const usageErrors: unknown[] = [];
    const mw = createForgeUsageMiddleware({
      store,
      config,
      resolveBrickId: (toolName) => provider.lookupBrickId(toolName),
      notifier,
      onUsageError: (_toolName, _brickId, error) => usageErrors.push(error),
    });

    // Simulate a tool call through the middleware
    const eventCountBefore3 = allEvents.length;
    const wrapToolCall = mw.wrapToolCall;
    if (wrapToolCall === undefined) {
      assert("wrapToolCall defined", false);
    } else {
      const ctx = stubTurnContext();
      const request: ToolRequest = { toolId: "counter", input: { text: "hello" } };
      const next = async (_req: ToolRequest): Promise<ToolResponse> => ({
        output: { count: 5 },
      });

      const response = await wrapToolCall(ctx, request, next);
      assert(
        "tool call returned correct output",
        (response.output as { count: number }).count === 5,
      );

      // Allow fire-and-forget to settle
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Check usage was recorded
      const loaded = await store.load(forgedBrickId);
      assert("brick loaded after usage", loaded.ok === true);
      if (loaded.ok) {
        assert("usage count is 1", loaded.value.usageCount === 1, `got ${loaded.value.usageCount}`);
      }

      // Check "updated" notification fired
      const updatedEvents = allEvents.filter(
        (e, i) => i >= eventCountBefore3 && e.kind === "updated",
      );
      assert(
        "notifier fired 'updated' event after usage recording",
        updatedEvents.length >= 1,
        `got ${updatedEvents.length} updated events`,
      );

      assert("no usage errors", usageErrors.length === 0, `${usageErrors.length} errors`);
    }

    provider.dispose();
  }
} catch (err: unknown) {
  assert("Test 3 completed", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 4: Promote brick → notifier fires event
// ---------------------------------------------------------------------------

console.log("\n[test 4] Promote brick → notifier fires event");

try {
  if (forgedBrickId === undefined) {
    assert("Test 4 requires forged brick", false, "no brick from test 1");
  } else {
    const eventCountBefore4 = allEvents.length;

    if (USE_CLAUDE) {
      // Full mode: Claude decides what arguments to pass
      const { toolCalls } = await withTimeout(
        () =>
          runAgentLoop(
            `Promote the brick with ID "${forgedBrickId}" — change its trust tier to "verified".`,
            SYSTEM_PROMPT,
          ),
        60_000,
        "Test 4",
      );

      const promoteCall = toolCalls.find((c) => c.name === "promote_forge");
      assert("Claude called promote_forge", promoteCall !== undefined);

      if (promoteCall !== undefined) {
        const result = promoteCall.result as {
          readonly ok: boolean;
          readonly value?: { readonly applied: boolean };
        };
        assert("promote_forge succeeded", result.ok === true, JSON.stringify(result).slice(0, 200));
      }
    } else {
      // Local mode: promote directly
      const result = (await promoteTool.execute({
        brickId: forgedBrickId,
        targetTrustTier: "verified",
      })) as { readonly ok: boolean; readonly value?: { readonly applied: boolean } };

      assert("promote_forge succeeded", result.ok === true, JSON.stringify(result).slice(0, 200));
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify notification fired (updated since in-memory store has no promote())
    const postPromoteEvents = allEvents.filter(
      (e, i) => i >= eventCountBefore4 && (e.kind === "updated" || e.kind === "promoted"),
    );
    assert(
      "notifier fired event after promotion",
      postPromoteEvents.length >= 1,
      `got ${postPromoteEvents.length} events: ${postPromoteEvents.map((e) => e.kind).join(", ")}`,
    );

    // Verify the brick was actually promoted
    const loaded = await store.load(forgedBrickId);
    if (loaded.ok) {
      assert(
        "brick trust tier is now verified",
        loaded.value.trustTier === "verified",
        `got ${loaded.value.trustTier}`,
      );
    }
  }
} catch (err: unknown) {
  assert("Test 4 completed", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 5: Auto-promotion via usage threshold
// ---------------------------------------------------------------------------

console.log("\n[test 5] Auto-promotion via usage threshold (sandbox → verified @ 3 uses)");

try {
  // Forge a fresh tool for auto-promotion testing
  const deps5 = makeDeps({
    context: {
      agentId: "e2e-notifier-agent",
      depth: 0,
      sessionId: `e2e-${Date.now()}`,
      forgesThisSession: 10,
    },
  });
  const freshForgeTool = createForgeToolTool(deps5);

  const forgeResult = (await freshForgeTool.execute({
    name: "auto-promo-tool",
    description: "Tool for auto-promotion testing",
    inputSchema: { type: "object" },
    implementation: "return { ok: true };",
  })) as { readonly ok: boolean; readonly value?: ForgeResult };

  assert("fresh tool forged for auto-promo test", forgeResult.ok === true);

  if (forgeResult.ok && forgeResult.value !== undefined) {
    const promoId = forgeResult.value.id;
    assert("fresh tool starts at sandbox tier", forgeResult.value.trustTier === "sandbox");

    // Record 3 usages (threshold is 3 for sandbox → verified)
    for (let i = 0; i < 3; i++) {
      await recordBrickUsage(store, promoId, config);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify auto-promotion happened
    const loaded = await store.load(promoId);
    assert("auto-promoted brick loads ok", loaded.ok === true);
    if (loaded.ok) {
      assert(
        "auto-promoted to verified after 3 uses",
        loaded.value.trustTier === "verified",
        `got ${loaded.value.trustTier} with ${loaded.value.usageCount} uses`,
      );
      assert("usage count is 3", loaded.value.usageCount === 3, `got ${loaded.value.usageCount}`);
    }
  }
} catch (err: unknown) {
  assert("Test 5 completed", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 6: Cross-agent invalidation — two providers share one notifier
// ---------------------------------------------------------------------------

console.log("\n[test 6] Cross-agent invalidation — two providers share one notifier");

try {
  // Provider A (agent A)
  const providerA = createForgeComponentProvider({
    store,
    executor: tieredExecutor,
    notifier,
    scope: "agent",
  });

  // Provider B (agent B)
  const providerB = createForgeComponentProvider({
    store,
    executor: tieredExecutor,
    notifier,
    scope: "agent",
  });

  // Both providers load initial state
  const initialA = await providerA.attach(stubAgent());
  const initialB = await providerB.attach(stubAgent());

  const initialCountA = initialA.size;
  const initialCountB = initialB.size;
  assert(
    "both providers see same initial tools",
    initialCountA === initialCountB,
    `A=${initialCountA}, B=${initialCountB}`,
  );

  // Agent A forges a new tool (through deps with notifier wired in)
  const crossDeps = makeDeps({
    context: {
      agentId: "e2e-notifier-agent",
      depth: 0,
      sessionId: `e2e-${Date.now()}`,
      forgesThisSession: 20,
    },
  });
  const crossForgeTool = createForgeToolTool(crossDeps);

  await crossForgeTool.execute({
    name: "cross-agent-tool",
    description: "Tool forged by agent A for cross-agent test",
    inputSchema: { type: "object" },
    implementation: "return { agent: 'A' };",
  });

  await new Promise((resolve) => setTimeout(resolve, 100));

  // Agent B's provider should have auto-invalidated due to "saved" notification
  const afterB = await providerB.attach(stubAgent());
  assert(
    "provider B sees new tool after cross-agent notification",
    afterB.size > initialCountB,
    `before=${initialCountB}, after=${afterB.size}`,
  );

  // Agent A's provider too
  const afterA = await providerA.attach(stubAgent());
  assert(
    "provider A also sees new tool",
    afterA.size > initialCountA,
    `before=${initialCountA}, after=${afterA.size}`,
  );

  providerA.dispose();
  providerB.dispose();
} catch (err: unknown) {
  assert("Test 6 completed", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 7: lookupBrickId resolves tool names after attach
// ---------------------------------------------------------------------------

console.log("\n[test 7] lookupBrickId resolves tool names after attach");

try {
  const provider = createForgeComponentProvider({
    store,
    executor: tieredExecutor,
    notifier,
  });

  // Before attach — should return undefined
  assert(
    "lookupBrickId returns undefined before attach",
    provider.lookupBrickId("counter") === undefined,
  );

  await provider.attach(stubAgent());

  // After attach — should resolve known tools
  const counterId = provider.lookupBrickId("counter");
  assert(
    "lookupBrickId resolves 'counter' after attach",
    counterId !== undefined,
    `got ${counterId}`,
  );
  if (forgedBrickId !== undefined) {
    assert("lookupBrickId returns correct brick ID", counterId === forgedBrickId);
  }

  // Non-forged tool — should return undefined
  assert(
    "lookupBrickId returns undefined for non-forged tool",
    provider.lookupBrickId("native-tool") === undefined,
  );

  provider.dispose();
} catch (err: unknown) {
  assert("Test 7 completed", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 8: dispose() unsubscribes from notifier
// ---------------------------------------------------------------------------

console.log("\n[test 8] dispose() unsubscribes provider from notifier");

try {
  const provider = createForgeComponentProvider({
    store,
    executor: tieredExecutor,
    notifier,
  });

  // Load initial tools
  const before = await provider.attach(stubAgent());
  const sizeBefore = before.size;

  // Dispose (unsubscribe from notifier)
  provider.dispose();

  // Forge another tool — notification fires but provider is disposed
  const disposeDeps = makeDeps({
    context: {
      agentId: "e2e-notifier-agent",
      depth: 0,
      sessionId: `e2e-${Date.now()}`,
      forgesThisSession: 30,
    },
  });
  const disposeForgeTool = createForgeToolTool(disposeDeps);

  await disposeForgeTool.execute({
    name: "after-dispose-tool",
    description: "Forged after provider dispose",
    inputSchema: { type: "object" },
    implementation: "return { ok: true };",
  });

  await new Promise((resolve) => setTimeout(resolve, 100));

  // Provider cache should NOT have been invalidated (it's disposed)
  // Re-attach should still return the cached (stale) result
  const after = await provider.attach(stubAgent());
  assert(
    "disposed provider cache not invalidated by new events",
    after.size === sizeBefore,
    `before=${sizeBefore}, after=${after.size}`,
  );
} catch (err: unknown) {
  assert("Test 8 completed", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.passed).length;
const total = results.length;
const allPassed = passed === total;

console.log(`\n[e2e] Results: ${passed}/${total} passed`);
console.log(`[e2e] Total notifier events captured: ${allEvents.length}`);
console.log(
  `[e2e] Event breakdown: ${JSON.stringify(
    allEvents.reduce(
      (acc, e) => {
        acc[e.kind] = (acc[e.kind] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    ),
  )}`,
);

if (!allPassed) {
  console.error("\n[e2e] Failed assertions:");
  for (const r of results) {
    if (!r.passed) {
      console.error(`  FAIL  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    }
  }
  process.exit(1);
}

console.log("\n[e2e] All notifier + usage middleware E2E tests passed!");
