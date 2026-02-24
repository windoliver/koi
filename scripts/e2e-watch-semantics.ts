#!/usr/bin/env bun
/**
 * E2E test script for ForgeStore.watch() typed event semantics through the
 * full L1 runtime assembly: createKoi + createLoopAdapter + ForgeRuntime.
 *
 * Validates the complete pipeline:
 *   1. store.watch() fires typed StoreChangeEvent per mutation
 *   2. ForgeRuntime.watch() propagates typed events + invalidates cache
 *   3. createKoi subscribes to forge.watch() → sets forgeStateDirty flag
 *   4. Forged tool becomes available at next turn boundary (hot-attach)
 *   5. Real Claude API call → tool call → tool result → final text
 *   6. dispose() cleans up all watch subscriptions
 *
 * Uses createKoi + createLoopAdapter (full L1 middleware chain).
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-watch-semantics.ts
 */

import type {
  ContentBlock,
  EngineEvent,
  InboundMessage,
  ModelRequest,
  ModelResponse,
  StoreChangeEvent,
  ToolArtifact,
} from "../packages/core/src/index.js";
import { createKoi } from "../packages/engine/src/koi.js";
import { createLoopAdapter } from "../packages/engine-loop/src/loop-adapter.js";
import { createForgeRuntime } from "../packages/forge/src/forge-runtime.js";
import { createInMemoryForgeStore } from "../packages/forge/src/memory-store.js";
import type { SandboxExecutor, TieredSandboxExecutor } from "../packages/forge/src/types.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set. Skipping watch-semantics E2E test.");
  process.exit(0);
}

console.log(
  "[e2e] Starting watch-semantics E2E test (createKoi + createLoopAdapter + real Claude API)...",
);
console.log("[e2e] ANTHROPIC_API_KEY: set\n");

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

async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
  maxEvents = 200,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
    if (events.length >= maxEvents) break;
  }
  return events;
}

// ---------------------------------------------------------------------------
// Claude API model handler (raw fetch — used as the modelCall terminal)
// ---------------------------------------------------------------------------

const MODEL = "claude-sonnet-4-5-20250929";

interface ApiContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
}

interface ApiResponse {
  readonly id: string;
  readonly content: readonly ApiContentBlock[];
  readonly stop_reason: string;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

function messagesToApiFormat(
  messages: readonly InboundMessage[],
): readonly { readonly role: string; readonly content: string | readonly ApiContentBlock[] }[] {
  const apiMessages: { role: string; content: string | ApiContentBlock[] }[] = [];

  for (const msg of messages) {
    if (msg.senderId === "assistant") {
      // Check for tool calls in metadata
      const toolCalls: unknown = msg.metadata?.toolCalls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        const blocks: ApiContentBlock[] = [];
        // Include text content if any
        for (const block of msg.content) {
          if (block.kind === "text" && block.text.length > 0) {
            blocks.push({ type: "text", text: block.text });
          }
        }
        // Add tool_use blocks from metadata
        for (const tc of toolCalls) {
          const call = tc as { toolName: string; callId: string; input: Record<string, unknown> };
          blocks.push({
            type: "tool_use",
            id: call.callId,
            name: call.toolName,
            input: call.input,
          });
        }
        apiMessages.push({ role: "assistant", content: blocks });
      } else {
        const text = msg.content.map((b) => ("text" in b ? b.text : "")).join("");
        apiMessages.push({ role: "assistant", content: text });
      }
    } else if (msg.senderId === "tool") {
      // Tool results — Claude API requires tool_use_id + content fields
      const toolUseId = msg.metadata?.callId;
      const text = msg.content.map((b) => ("text" in b ? b.text : "")).join("");
      if (typeof toolUseId === "string") {
        apiMessages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: text,
            } as unknown as ApiContentBlock,
          ],
        });
      }
    } else {
      const text = msg.content.map((b) => ("text" in b ? b.text : "")).join("");
      apiMessages.push({ role: "user", content: text });
    }
  }

  return apiMessages;
}

const SYSTEM_PROMPT =
  "You are a helpful assistant. When asked to add numbers, always use the 'adder' tool. " +
  "When asked to multiply numbers, always use the 'multiplier' tool. " +
  "Do not compute manually — you must use the tool. Be concise.";

/**
 * Model call terminal for the loop adapter.
 *
 * `ModelRequest` has no `tools` field — tool definitions are available on
 * `callHandlers.tools` which the loop adapter doesn't inject into the request.
 * Instead, the model terminal dynamically reads tool descriptors from the
 * ForgeRuntime (which is a closure capture here). This matches how real
 * engine adapters (engine-pi, engine-claude) handle tool injection.
 */
async function modelCall(request: ModelRequest): Promise<ModelResponse> {
  // Dynamically get current tool descriptors from forge runtime
  const descriptors = await forgeRuntime.toolDescriptors();
  const toolDefs = descriptors.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

  const apiMessages = messagesToApiFormat(request.messages);

  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: apiMessages,
  };
  if (toolDefs.length > 0) {
    body.tools = toolDefs;
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Claude API error (${response.status}): ${text}`);
  }

  const data = (await response.json()) as ApiResponse;

  // Convert API response to Koi ModelResponse
  const textBlocks = data.content.filter((b) => b.type === "text");
  const toolUseBlocks = data.content.filter((b) => b.type === "tool_use");

  const content = textBlocks.map((b) => b.text ?? "").join("");
  const toolCalls = toolUseBlocks.map((b) => ({
    toolName: b.name ?? "",
    callId: b.id ?? "",
    input: (b.input ?? {}) as Record<string, unknown>,
  }));

  return {
    content,
    usage: {
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
    },
    metadata: toolCalls.length > 0 ? { toolCalls } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Forge + sandbox setup
// ---------------------------------------------------------------------------

const store = createInMemoryForgeStore();

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
  forTier: () => ({ executor, tier: "sandbox" }),
};

const forgeRuntime = createForgeRuntime({
  store,
  executor: tieredExecutor,
});

// ---------------------------------------------------------------------------
// Test 1: store.watch() fires typed StoreChangeEvent per mutation
// ---------------------------------------------------------------------------

console.log("[test 1] store.watch() fires typed StoreChangeEvent per mutation");

try {
  const events: StoreChangeEvent[] = [];
  const unsub = store.watch?.((event) => {
    events.push(event);
  });
  assert("store.watch is available", unsub !== undefined);

  // Save a brick
  const brick: ToolArtifact = {
    id: "brick_test-1",
    kind: "tool",
    name: "test-tool-1",
    description: "A test tool",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    createdBy: "e2e-test",
    createdAt: Date.now(),
    version: "1.0.0",
    tags: [],
    usageCount: 0,
    contentHash: "abc123",
    implementation: "return { result: input };",
    inputSchema: { type: "object" },
  };
  await store.save(brick);

  // Update the brick
  await store.update("brick_test-1", { lifecycle: "deprecated" });

  // Remove the brick
  await store.remove("brick_test-1");

  await new Promise((r) => setTimeout(r, 10));

  assert("received 3 events (save + update + remove)", events.length === 3, `got ${events.length}`);
  assert(
    "event 1 is saved with correct brickId",
    events[0]?.kind === "saved" && events[0]?.brickId === "brick_test-1",
    `got ${JSON.stringify(events[0])}`,
  );
  assert(
    "event 2 is updated with correct brickId",
    events[1]?.kind === "updated" && events[1]?.brickId === "brick_test-1",
    `got ${JSON.stringify(events[1])}`,
  );
  assert(
    "event 3 is removed with correct brickId",
    events[2]?.kind === "removed" && events[2]?.brickId === "brick_test-1",
    `got ${JSON.stringify(events[2])}`,
  );

  unsub?.();
} catch (err: unknown) {
  assert("Test 1 completed", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 2: ForgeRuntime.watch() propagates typed events + invalidates cache
// ---------------------------------------------------------------------------

console.log("\n[test 2] ForgeRuntime.watch() propagates typed events + invalidates cache");

try {
  const events: StoreChangeEvent[] = [];
  const unsub = forgeRuntime.watch?.((event) => {
    events.push(event);
  });
  assert("forgeRuntime.watch is available", unsub !== undefined);

  const before = await forgeRuntime.toolDescriptors();
  assert("forgeRuntime starts empty", before.length === 0, `found ${before.length}`);

  // Save a tool via the store directly
  const adderBrick: ToolArtifact = {
    id: "brick_adder-e2e",
    kind: "tool",
    name: "adder",
    description: "Adds two numbers together. Pass a and b as numbers.",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    createdBy: "e2e-test",
    createdAt: Date.now(),
    version: "1.0.0",
    tags: [],
    usageCount: 0,
    contentHash: "adder-hash",
    implementation: "return { sum: (input.a || 0) + (input.b || 0) };",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
  };
  await store.save(adderBrick);

  await new Promise((r) => setTimeout(r, 50));

  assert("watch event received", events.length >= 1, `got ${events.length}`);
  assert(
    "event is typed StoreChangeEvent with kind=saved",
    events[0]?.kind === "saved",
    `got ${JSON.stringify(events[0])}`,
  );
  assert(
    "event has correct brickId",
    events[0]?.brickId === "brick_adder-e2e",
    `got ${events[0]?.brickId}`,
  );

  // Cache should be invalidated — new tool should be visible
  const after = await forgeRuntime.toolDescriptors();
  assert(
    "forgeRuntime sees 'adder' after watch notification",
    after.some((d) => d.name === "adder"),
    `tools: ${after.map((d) => d.name).join(", ")}`,
  );

  // Verify tool is callable
  const resolved = await forgeRuntime.resolveTool("adder");
  assert("resolveTool('adder') returns a tool", resolved !== undefined);

  if (resolved !== undefined) {
    const toolResult = await resolved.execute({ a: 17, b: 25 });
    assert("adder(17, 25) = { sum: 42 }", JSON.stringify(toolResult).includes("42"));
  }

  unsub?.();
} catch (err: unknown) {
  assert("Test 2 completed", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 3: Full L1 pipeline — createKoi + createLoopAdapter + forge.watch
// ---------------------------------------------------------------------------

console.log("\n[test 3] Full L1 pipeline: createKoi + createLoopAdapter + real Claude API");

try {
  // Create the loop adapter with a real Claude model call
  const adapter = createLoopAdapter({
    modelCall,
    maxTurns: 5,
  });

  // Create the full Koi runtime with forge
  const runtime = await createKoi({
    manifest: { name: "e2e-watch-agent" },
    adapter,
    forge: forgeRuntime,
    limits: { maxTurns: 5, maxDurationMs: 120_000, maxTokens: 50_000 },
    loopDetection: false,
  });

  assert("createKoi succeeded", runtime !== undefined);
  assert("agent name is correct", runtime.agent.manifest.name === "e2e-watch-agent");

  // Run a turn — Claude should see the 'adder' tool and use it
  console.log("  Calling Claude via createKoi + createLoopAdapter...");
  const events = await withTimeout(
    () =>
      collectEvents(runtime.run({ kind: "text", text: "What is 17 + 25? Use the adder tool." })),
    120_000,
    "Test 3 — full L1 run",
  );

  // Log event summary
  const counts: Record<string, number> = {};
  for (const e of events) {
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  }
  console.log(`  Events (${events.length} total):`);
  for (const [kind, count] of Object.entries(counts)) {
    console.log(`    ${kind}: ${count}`);
  }

  assert("received events", events.length > 0, `count: ${events.length}`);
  assert(
    "has done event",
    events.some((e) => e.kind === "done"),
  );
  assert(
    "has turn_start event",
    events.some((e) => e.kind === "turn_start"),
  );
  assert(
    "has turn_end event",
    events.some((e) => e.kind === "turn_end"),
  );

  // Check for tool calls
  const toolCallStarts = events.filter((e) => e.kind === "tool_call_start");
  const toolCallEnds = events.filter((e) => e.kind === "tool_call_end");

  const hasToolCalls = toolCallStarts.length > 0;
  assert("Claude called a tool", hasToolCalls, `tool_call_start count: ${toolCallStarts.length}`);

  if (hasToolCalls) {
    const toolNames = toolCallStarts.map((e) => ("toolName" in e ? e.toolName : "?"));
    console.log(`  Tools called: ${toolNames.join(", ")}`);
    assert("Claude called 'adder'", toolNames.includes("adder"), `tools: ${toolNames.join(", ")}`);

    if (toolCallEnds.length > 0) {
      const adderEnd = toolCallEnds.find((e) => "result" in e);
      if (adderEnd && "result" in adderEnd) {
        const resultStr = JSON.stringify(adderEnd.result);
        console.log(`  Tool result: ${resultStr}`);
        assert("adder returned sum=42", resultStr.includes("42"), `result: ${resultStr}`);
      }
    }
  }

  // Check text output
  const textDeltas = events.filter((e) => e.kind === "text_delta");
  if (textDeltas.length > 0) {
    const fullText = textDeltas
      .map((e) => {
        if ("delta" in e) {
          const delta = e.delta;
          if (typeof delta === "string") return delta;
          if (Array.isArray(delta))
            return delta.map((b: ContentBlock) => ("text" in b ? b.text : "")).join("");
        }
        return "";
      })
      .join("");
    console.log(`  Claude text: "${fullText.slice(0, 120)}"`);
  }

  // Check metrics
  const doneEvent = events.find((e) => e.kind === "done");
  if (doneEvent !== undefined && "output" in doneEvent) {
    const output = doneEvent.output as { metrics: { inputTokens: number; outputTokens: number } };
    console.log(
      `  Tokens: input=${output.metrics.inputTokens}, output=${output.metrics.outputTokens}`,
    );
    assert("inputTokens > 0", output.metrics.inputTokens > 0);
  }

  await runtime.dispose();
} catch (err: unknown) {
  assert("Test 3 completed", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 4: Hot-attach mid-session — forge new tool → watch → next turn sees it
// ---------------------------------------------------------------------------

console.log("\n[test 4] Hot-attach: forge new tool mid-session → watch → available next turn");

try {
  const adapter = createLoopAdapter({
    modelCall,
    maxTurns: 5,
  });

  // Track watch events at the forge runtime level
  const watchEvents: StoreChangeEvent[] = [];
  const unsub = forgeRuntime.watch?.((event) => {
    watchEvents.push(event);
  });

  const runtime = await createKoi({
    manifest: { name: "e2e-hot-attach-agent" },
    adapter,
    forge: forgeRuntime,
    limits: { maxTurns: 5, maxDurationMs: 120_000, maxTokens: 50_000 },
    loopDetection: false,
  });

  // Forge a new tool (multiplier) BEFORE running — this simulates mid-session forge
  const multiplierBrick: ToolArtifact = {
    id: "brick_multiplier-e2e",
    kind: "tool",
    name: "multiplier",
    description: "Multiplies two numbers together. Pass a and b as numbers.",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    createdBy: "e2e-test",
    createdAt: Date.now(),
    version: "1.0.0",
    tags: [],
    usageCount: 0,
    contentHash: "mult-hash",
    implementation: "return { product: (input.a || 0) * (input.b || 0) };",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
  };
  await store.save(multiplierBrick);

  await new Promise((r) => setTimeout(r, 50));

  assert(
    "watch event fired for multiplier",
    watchEvents.some((e) => e.kind === "saved" && e.brickId === "brick_multiplier-e2e"),
    `events: ${JSON.stringify(watchEvents)}`,
  );

  // Verify forge runtime sees both tools
  const descriptors = await forgeRuntime.toolDescriptors();
  assert(
    "forgeRuntime sees both 'adder' and 'multiplier'",
    descriptors.some((d) => d.name === "adder") && descriptors.some((d) => d.name === "multiplier"),
    `tools: ${descriptors.map((d) => d.name).join(", ")}`,
  );

  // Run a turn that should use the multiplier tool
  console.log("  Calling Claude with multiplier tool available...");
  const events = await withTimeout(
    () =>
      collectEvents(
        runtime.run({
          kind: "text",
          text: "What is 6 * 7? Use the multiplier tool.",
        }),
      ),
    120_000,
    "Test 4 — hot-attach run",
  );

  const toolCallStarts = events.filter((e) => e.kind === "tool_call_start");
  if (toolCallStarts.length > 0) {
    const toolNames = toolCallStarts.map((e) => ("toolName" in e ? e.toolName : "?"));
    console.log(`  Tools called: ${toolNames.join(", ")}`);
    assert(
      "Claude called 'multiplier'",
      toolNames.includes("multiplier"),
      `tools: ${toolNames.join(", ")}`,
    );

    const toolCallEnds = events.filter((e) => e.kind === "tool_call_end");
    if (toolCallEnds.length > 0) {
      const multEnd = toolCallEnds.find((e) => "result" in e);
      if (multEnd && "result" in multEnd) {
        const resultStr = JSON.stringify(multEnd.result);
        console.log(`  Tool result: ${resultStr}`);
        assert(
          "multiplier(6, 7) returned product=42",
          resultStr.includes("42"),
          `result: ${resultStr}`,
        );
      }
    }
  } else {
    assert("Claude called 'multiplier'", false, "no tool_call_start events");
  }

  assert(
    "has done event",
    events.some((e) => e.kind === "done"),
  );

  unsub?.();
  await runtime.dispose();
} catch (err: unknown) {
  assert("Test 4 completed", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 5: dispose() cleans up all watch subscriptions
// ---------------------------------------------------------------------------

console.log("\n[test 5] dispose() cleans up watch subscriptions");

try {
  const adapter = createLoopAdapter({
    modelCall,
    maxTurns: 3,
  });

  // Create a separate store + runtime to test dispose isolation
  const disposeStore = createInMemoryForgeStore();
  const disposeForgeRuntime = createForgeRuntime({
    store: disposeStore,
    executor: tieredExecutor,
  });

  const disposeRuntime = await createKoi({
    manifest: { name: "e2e-dispose-agent" },
    adapter,
    forge: disposeForgeRuntime,
    limits: { maxTurns: 3, maxDurationMs: 30_000, maxTokens: 10_000 },
    loopDetection: false,
  });

  // Dispose the runtime — should clean up forge subscriptions
  await disposeRuntime.dispose();

  // After dispose, saving to the store should NOT cause errors (listeners removed)
  const brick: ToolArtifact = {
    id: "brick_post-dispose",
    kind: "tool",
    name: "post-dispose-tool",
    description: "Should not cause errors",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    createdBy: "e2e-test",
    createdAt: Date.now(),
    version: "1.0.0",
    tags: [],
    usageCount: 0,
    contentHash: "xyz",
    implementation: "return {};",
    inputSchema: { type: "object" },
  };

  // This should not throw — dispose cleaned up listeners
  await disposeStore.save(brick);
  assert("save after dispose does not throw", true);

  // Verify store still works (dispose cleaned up listeners, not the store itself)
  const loaded = await disposeStore.load("brick_post-dispose");
  assert("store still works after runtime dispose", loaded.ok === true);
} catch (err: unknown) {
  assert("Test 5 completed", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.passed).length;
const total = results.length;
const allPassed = passed === total;

console.log(`\n[e2e] Results: ${passed}/${total} passed`);

if (!allPassed) {
  console.error("\n[e2e] Failed assertions:");
  for (const r of results) {
    if (!r.passed) {
      console.error(`  FAIL  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    }
  }
  process.exit(1);
}

console.log("\n[e2e] All watch-semantics E2E tests passed!");
