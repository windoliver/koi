/**
 * E2E: Full resolve pipeline → createKoi → real LLM calls.
 *
 * Validates that the engine resolve pipeline works end-to-end:
 *   1. resolveAgent() resolves model + middleware from a manifest
 *   2. resolved.value.engine / createLoopAdapter wires into createKoi
 *   3. Real LLM calls stream events through the middleware chain
 *   4. Tool calls round-trip through wrapToolCall middleware hooks
 *   5. Lifecycle hooks fire in correct order
 *
 * Tests both the createLoopAdapter path (default, no engine in manifest)
 * and the createPiAdapter path (stream-based, with tools + middleware).
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-engine-resolve.test.ts
 *
 * Requires ANTHROPIC_API_KEY in .env (auto-loaded by Bun).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentManifest,
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  ModelRequest,
  Tool,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createPiAdapter } from "@koi/engine-pi";
import { loadManifest } from "@koi/manifest";
import { createAnthropicAdapter } from "@koi/model-router";
import { formatResolutionError, resolveAgent } from "../resolve-agent.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = join(tmpdir(), `koi-e2e-engine-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
  tempDirs.length = 0;
});

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

function testManifest(overrides?: Partial<AgentManifest>): AgentManifest {
  return {
    name: "e2e-engine-resolve-agent",
    version: "0.1.0",
    model: { name: `anthropic:${E2E_MODEL}` },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const MULTIPLY_TOOL: Tool = {
  descriptor: {
    name: "multiply",
    description: "Multiplies two numbers together and returns the product.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
  },
  trustTier: "sandbox",
  execute: async (input: Readonly<Record<string, unknown>>) => {
    const a = Number(input.a ?? 0);
    const b = Number(input.b ?? 0);
    return String(a * b);
  },
};

const GET_WEATHER_TOOL: Tool = {
  descriptor: {
    name: "get_weather",
    description: "Returns the current weather for a city. Always returns sunny 22C for testing.",
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
    const city = String(input.city ?? "unknown");
    return JSON.stringify({ city, temperature: 22, condition: "sunny" });
  },
};

function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "e2e-tool-provider",
    attach: async () => new Map(tools.map((t) => [toolToken(t.descriptor.name) as string, t])),
  };
}

// ===========================================================================
// SECTION 1: createLoopAdapter path (resolve pipeline → Anthropic model)
// ===========================================================================

describeE2E("e2e: resolve pipeline → createLoopAdapter → real Anthropic LLM", () => {
  test(
    "resolveAgent + createLoopAdapter streams text through full L1 runtime",
    async () => {
      // 1. Create manifest file
      const dir = makeTempDir();
      tempDirs.push(dir);
      writeFileSync(
        join(dir, "koi.yaml"),
        ["name: e2e-loop-agent", "version: 0.1.0", `model: "anthropic:${E2E_MODEL}"`].join("\n"),
      );

      // 2. Load manifest
      const loadResult = await loadManifest(join(dir, "koi.yaml"));
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;

      // 3. Resolve via CLI pipeline (tests ALL_DESCRIPTORS registration)
      const resolved = await resolveAgent({
        manifestPath: join(dir, "koi.yaml"),
        manifest: loadResult.value.manifest,
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) {
        process.stderr.write(formatResolutionError(resolved.error));
        return;
      }

      // 4. Assemble: resolved engine or fallback to loop
      const adapter =
        resolved.value.engine ?? createLoopAdapter({ modelCall: resolved.value.model });

      // 5. Wire through createKoi (full L1 runtime)
      const runtime = await createKoi({
        manifest: loadResult.value.manifest,
        adapter,
        middleware: resolved.value.middleware,
        loopDetection: false,
      });

      expect(runtime.agent.state).toBe("created");

      // 6. Run with real LLM
      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly: pong" }),
      );

      expect(runtime.agent.state).toBe("terminated");

      // 7. Verify
      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      if (output === undefined) return;

      expect(output.stopReason).toBe("completed");
      expect(output.metrics.inputTokens).toBeGreaterThan(0);
      expect(output.metrics.outputTokens).toBeGreaterThan(0);
      expect(output.metrics.turns).toBeGreaterThanOrEqual(1);

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("pong");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "createPiAdapter with tool calls through middleware chain (loop adapter is text-only)",
    async () => {
      // Track tool calls through middleware
      const toolCallsObserved: string[] = [];

      const toolObserver: KoiMiddleware = {
        name: "e2e-tool-observer",
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolCallsObserved.push(request.toolId);
          return next(request);
        },
      };

      // Pi adapter supports tool calls natively (sends tool schemas to LLM)
      const adapter = createPiAdapter({
        model: `anthropic:${E2E_MODEL}`,
        systemPrompt:
          "You MUST use the multiply tool to answer math questions. Do not compute in your head. Always use the tool.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [toolObserver],
        providers: [createToolProvider([MULTIPLY_TOOL])],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the multiply tool to compute 7 * 8. Then tell me the result.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Middleware must have intercepted the tool call
      expect(toolCallsObserved.length).toBeGreaterThanOrEqual(1);
      expect(toolCallsObserved).toContain("multiply");

      // Events must include tool lifecycle
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      const toolEnds = events.filter((e) => e.kind === "tool_call_end");
      expect(toolStarts.length).toBeGreaterThanOrEqual(1);
      expect(toolEnds.length).toBeGreaterThanOrEqual(1);

      // Response should contain the result of 7 * 8
      const text = extractText(events);
      expect(text).toContain("56");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "middleware lifecycle hooks fire in correct order",
    async () => {
      const hookOrder: string[] = [];

      const lifecycleObserver: KoiMiddleware = {
        name: "e2e-lifecycle-observer",
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

      const provider = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
      const modelCall = (request: ModelRequest) =>
        provider.complete({ ...request, model: E2E_MODEL });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [lifecycleObserver],
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Say: OK" }));

      // Session lifecycle must be correct
      expect(hookOrder[0]).toBe("session_start");
      expect(hookOrder[hookOrder.length - 1]).toBe("session_end");
      expect(hookOrder).toContain("after_turn");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "multiple tools with middleware logging each call (via Pi adapter)",
    async () => {
      const toolCalls: string[] = [];

      const toolLogger: KoiMiddleware = {
        name: "e2e-tool-logger",
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolCalls.push(request.toolId);
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: `anthropic:${E2E_MODEL}`,
        systemPrompt:
          "You have access to multiply and get_weather tools. Use them when asked. Always use tools instead of computing yourself.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [toolLogger],
        providers: [createToolProvider([MULTIPLY_TOOL, GET_WEATHER_TOOL])],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "First, use get_weather for Tokyo. Then use multiply to compute 9 * 11. Report both results.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // At least one tool should have been called
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);

      // Response should reference results
      const text = extractText(events);
      const hasWeather = text.includes("22") || text.includes("sunny") || text.includes("Tokyo");
      const hasMath = text.includes("99");
      expect(hasWeather || hasMath).toBe(true);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "iteration guard limits turns with real LLM",
    async () => {
      const provider = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
      const modelCall = (request: ModelRequest) =>
        provider.complete({ ...request, model: E2E_MODEL });

      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [createToolProvider([MULTIPLY_TOOL])],
        limits: { maxTurns: 3 },
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Compute 2*3, then 4*5, then 6*7, then 8*9, then 10*11. Report all results.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.metrics.turns).toBeLessThanOrEqual(3);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});

// ===========================================================================
// SECTION 2: createPiAdapter path (stream-based, full L1 runtime)
// ===========================================================================

describeE2E("e2e: createPiAdapter → full createKoi runtime with real LLM", () => {
  test(
    "streams text response through createKoi + createPiAdapter",
    async () => {
      const adapter = createPiAdapter({
        model: `anthropic:${E2E_MODEL}`,
        systemPrompt: "You are a concise assistant. Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        loopDetection: false,
      });

      expect(runtime.agent.state).toBe("created");

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly: pong" }),
      );

      expect(runtime.agent.state).toBe("terminated");

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      if (output === undefined) return;

      expect(output.stopReason).toBe("completed");
      expect(output.metrics.inputTokens).toBeGreaterThan(0);
      expect(output.metrics.outputTokens).toBeGreaterThan(0);

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("pong");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "Pi adapter + tools + middleware round-trip",
    async () => {
      let toolCallObserved = false;

      const observerMiddleware: KoiMiddleware = {
        name: "e2e-pi-tool-observer",
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolCallObserved = true;
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: `anthropic:${E2E_MODEL}`,
        systemPrompt:
          "You MUST use the multiply tool to answer math questions. Do not compute in your head.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [observerMiddleware],
        providers: [createToolProvider([MULTIPLY_TOOL])],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the multiply tool to compute 6 * 9. Tell me the result.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Middleware should have observed the tool call
      expect(toolCallObserved).toBe(true);

      // Response should contain 54
      const text = extractText(events);
      expect(text).toContain("54");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});

// ===========================================================================
// SECTION 3: resolveAgent pipeline integration
// ===========================================================================

// Tests that need a real API key (model factory requires it even though no LLM call is made)
const describeWithKey = HAS_KEY ? describe : describe.skip;

describeWithKey("resolve pipeline integration (requires API key)", () => {
  test("resolveAgent resolves model + empty middleware from minimal manifest", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    writeFileSync(
      join(dir, "koi.yaml"),
      ["name: resolve-test", "version: 0.1.0", `model: "anthropic:${E2E_MODEL}"`].join("\n"),
    );

    const loadResult = await loadManifest(join(dir, "koi.yaml"));
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const resolved = await resolveAgent({
      manifestPath: join(dir, "koi.yaml"),
      manifest: loadResult.value.manifest,
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      process.stderr.write(formatResolutionError(resolved.error));
      return;
    }

    // Model handler should be a function
    expect(typeof resolved.value.model).toBe("function");

    // No middleware in manifest → empty array
    expect(resolved.value.middleware).toEqual([]);

    // No engine in manifest → undefined
    expect(resolved.value.engine).toBeUndefined();
  });

  test("resolveAgent with engine section resolves engine adapter", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    writeFileSync(
      join(dir, "koi.yaml"),
      [
        "name: engine-resolve-test",
        "version: 0.1.0",
        `model: "anthropic:${E2E_MODEL}"`,
        "engine:",
        '  name: "external"',
        "  options:",
        '    command: "echo hello"',
      ].join("\n"),
    );

    const loadResult = await loadManifest(join(dir, "koi.yaml"));
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const resolved = await resolveAgent({
      manifestPath: join(dir, "koi.yaml"),
      manifest: loadResult.value.manifest,
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      process.stderr.write(formatResolutionError(resolved.error));
      return;
    }

    // Engine should be resolved (not undefined)
    expect(resolved.value.engine).toBeDefined();
    expect(typeof resolved.value.engine?.stream).toBe("function");
  });
});

// ===========================================================================
// SECTION 4: External engine through full createKoi runtime (real processes)
// ===========================================================================

describeWithKey("e2e: external engine → createKoi → runtime.run() (real processes)", () => {
  test("echo command through full resolve → createKoi → runtime.run() pipeline", async () => {
    // 1. Create koi.yaml with external engine
    const dir = makeTempDir();
    tempDirs.push(dir);
    writeFileSync(
      join(dir, "koi.yaml"),
      [
        "name: e2e-external-echo",
        "version: 0.1.0",
        `model: "anthropic:${E2E_MODEL}"`,
        "engine:",
        '  name: "external"',
        "  options:",
        '    command: "echo"',
        "    args:",
        '      - "hello from external engine"',
      ].join("\n"),
    );

    // 2. Load manifest
    const loadResult = await loadManifest(join(dir, "koi.yaml"));
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    // 3. Resolve through full CLI pipeline (ALL_DESCRIPTORS registry)
    const resolved = await resolveAgent({
      manifestPath: join(dir, "koi.yaml"),
      manifest: loadResult.value.manifest,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      process.stderr.write(formatResolutionError(resolved.error));
      return;
    }

    // Engine MUST be resolved (not undefined — this is the external adapter)
    expect(resolved.value.engine).toBeDefined();
    if (resolved.value.engine === undefined) return;

    // 4. Assemble via createKoi with the resolved external engine
    const runtime = await createKoi({
      manifest: loadResult.value.manifest,
      adapter: resolved.value.engine,
      middleware: resolved.value.middleware,
      loopDetection: false,
    });

    expect(runtime.agent.state).toBe("created");

    // 5. Run — echo ignores stdin, writes "hello from external engine" to stdout
    const events = await collectEvents(runtime.run({ kind: "text", text: "ignored input" }));

    // 6. Verify
    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    if (output === undefined) return;

    expect(output.stopReason).toBe("completed");

    const text = extractText(events);
    expect(text).toContain("hello from external engine");

    await runtime.dispose();
  }, 30_000);

  test("cat command round-trips stdin → stdout through full pipeline", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    writeFileSync(
      join(dir, "koi.yaml"),
      [
        "name: e2e-external-cat",
        "version: 0.1.0",
        `model: "anthropic:${E2E_MODEL}"`,
        "engine:",
        '  name: "external"',
        "  options:",
        '    command: "cat"',
      ].join("\n"),
    );

    const loadResult = await loadManifest(join(dir, "koi.yaml"));
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const resolved = await resolveAgent({
      manifestPath: join(dir, "koi.yaml"),
      manifest: loadResult.value.manifest,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.engine).toBeDefined();
    if (resolved.value.engine === undefined) return;

    const runtime = await createKoi({
      manifest: loadResult.value.manifest,
      adapter: resolved.value.engine,
      middleware: resolved.value.middleware,
      loopDetection: false,
    });

    // cat echoes stdin to stdout — tests the full stdin/stdout protocol
    const events = await collectEvents(
      runtime.run({ kind: "text", text: "round-trip-test-payload" }),
    );

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("completed");

    const text = extractText(events);
    expect(text).toContain("round-trip-test-payload");

    await runtime.dispose();
  }, 30_000);

  test("middleware hooks fire with external engine", async () => {
    const hooksFired: string[] = [];

    const lifecycleMiddleware: KoiMiddleware = {
      name: "e2e-external-lifecycle",
      onSessionStart: async () => {
        hooksFired.push("session_start");
      },
      onSessionEnd: async () => {
        hooksFired.push("session_end");
      },
      onAfterTurn: async () => {
        hooksFired.push("after_turn");
      },
    };

    const dir = makeTempDir();
    tempDirs.push(dir);
    writeFileSync(
      join(dir, "koi.yaml"),
      [
        "name: e2e-external-middleware",
        "version: 0.1.0",
        `model: "anthropic:${E2E_MODEL}"`,
        "engine:",
        '  name: "external"',
        "  options:",
        '    command: "echo"',
        "    args:",
        '      - "middleware test"',
      ].join("\n"),
    );

    const loadResult = await loadManifest(join(dir, "koi.yaml"));
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const resolved = await resolveAgent({
      manifestPath: join(dir, "koi.yaml"),
      manifest: loadResult.value.manifest,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.engine).toBeDefined();
    if (resolved.value.engine === undefined) return;

    const runtime = await createKoi({
      manifest: loadResult.value.manifest,
      adapter: resolved.value.engine,
      middleware: [lifecycleMiddleware],
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    // Middleware session lifecycle must fire around the external engine
    // Note: onAfterTurn requires turn_end events from the adapter;
    // external engine emits done directly, so only session hooks fire
    expect(hooksFired).toContain("session_start");
    expect(hooksFired).toContain("session_end");
    expect(hooksFired[0]).toBe("session_start");
    expect(hooksFired[hooksFired.length - 1]).toBe("session_end");

    await runtime.dispose();
  }, 30_000);

  test("shell script as external engine processes stdin and writes to stdout", async () => {
    // Write a helper shell script that reads stdin and echoes it back
    const dir = makeTempDir();
    tempDirs.push(dir);

    const scriptPath = join(dir, "echo-stdin.sh");
    writeFileSync(scriptPath, '#!/bin/sh\ninput=$(cat)\necho "processed: $input"\n', {
      mode: 0o755,
    });

    writeFileSync(
      join(dir, "koi.yaml"),
      [
        "name: e2e-external-shell",
        "version: 0.1.0",
        `model: "anthropic:${E2E_MODEL}"`,
        "engine:",
        '  name: "external"',
        "  options:",
        `    command: "${scriptPath}"`,
      ].join("\n"),
    );

    const loadResult = await loadManifest(join(dir, "koi.yaml"));
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const resolved = await resolveAgent({
      manifestPath: join(dir, "koi.yaml"),
      manifest: loadResult.value.manifest,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.engine).toBeDefined();
    if (resolved.value.engine === undefined) return;

    const runtime = await createKoi({
      manifest: loadResult.value.manifest,
      adapter: resolved.value.engine,
      middleware: resolved.value.middleware,
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "koi-engine-input" }));

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("completed");

    const text = extractText(events);
    expect(text).toContain("processed:");
    expect(text).toContain("koi-engine-input");

    await runtime.dispose();
  }, 30_000);

  test("exit code 1 from external engine yields error stopReason through full pipeline", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    writeFileSync(
      join(dir, "koi.yaml"),
      [
        "name: e2e-external-error",
        "version: 0.1.0",
        `model: "anthropic:${E2E_MODEL}"`,
        "engine:",
        '  name: "external"',
        "  options:",
        '    command: "sh"',
        "    args:",
        '      - "-c"',
        '      - "echo oops >&2; exit 1"',
      ].join("\n"),
    );

    const loadResult = await loadManifest(join(dir, "koi.yaml"));
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const resolved = await resolveAgent({
      manifestPath: join(dir, "koi.yaml"),
      manifest: loadResult.value.manifest,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.engine).toBeDefined();
    if (resolved.value.engine === undefined) return;

    const runtime = await createKoi({
      manifest: loadResult.value.manifest,
      adapter: resolved.value.engine,
      middleware: resolved.value.middleware,
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "trigger error" }));

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("error");

    await runtime.dispose();
  }, 30_000);
});

// ===========================================================================
// SECTION 5: Codex as external engine (requires OPENAI_API_KEY)
// ===========================================================================

const HAS_OPENAI_KEY = (process.env.OPENAI_API_KEY ?? "").length > 0;
const describeCodex = HAS_OPENAI_KEY && E2E_OPTED_IN ? describe : describe.skip;

describeCodex("e2e: Codex CLI as external engine through full pipeline", () => {
  test(
    "codex exec processes prompt through full resolve → createKoi → runtime.run()",
    async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);

      // Shell wrapper: reads stdin prompt → passes to codex exec → stdout
      const scriptPath = join(dir, "codex-wrapper.sh");
      writeFileSync(scriptPath, '#!/bin/sh\nprompt=$(cat)\ncodex exec "$prompt" 2>/dev/null\n', {
        mode: 0o755,
      });

      writeFileSync(
        join(dir, "koi.yaml"),
        [
          "name: e2e-codex-agent",
          "version: 0.1.0",
          `model: "anthropic:${E2E_MODEL}"`,
          "engine:",
          '  name: "external"',
          "  options:",
          `    command: "${scriptPath}"`,
          "    timeoutMs: 120000",
        ].join("\n"),
      );

      const loadResult = await loadManifest(join(dir, "koi.yaml"));
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;

      const resolved = await resolveAgent({
        manifestPath: join(dir, "koi.yaml"),
        manifest: loadResult.value.manifest,
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) {
        process.stderr.write(formatResolutionError(resolved.error));
        return;
      }
      expect(resolved.value.engine).toBeDefined();
      if (resolved.value.engine === undefined) return;

      const runtime = await createKoi({
        manifest: loadResult.value.manifest,
        adapter: resolved.value.engine,
        middleware: resolved.value.middleware,
        loopDetection: false,
      });

      // Send prompt via stdin → shell wrapper → codex exec → stdout
      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly one word: pong" }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      if (output === undefined) return;

      expect(output.stopReason).toBe("completed");

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("pong");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});

// Error-path tests don't need a real API key — they fail before model instantiation
describe("resolve pipeline error paths (deterministic)", () => {
  test("resolveAgent with engine string shorthand fails without command option", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    writeFileSync(
      join(dir, "koi.yaml"),
      [
        "name: engine-shorthand-test",
        "version: 0.1.0",
        `model: "anthropic:${E2E_MODEL}"`,
        'engine: "external"',
      ].join("\n"),
    );

    const loadResult = await loadManifest(join(dir, "koi.yaml"));
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const resolved = await resolveAgent({
      manifestPath: join(dir, "koi.yaml"),
      manifest: loadResult.value.manifest,
    });

    // Should fail — engine "external" requires a command option
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;

    expect(resolved.error.message).toContain("command");
  });

  test("resolveAgent returns error for unknown engine name", async () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    writeFileSync(
      join(dir, "koi.yaml"),
      [
        "name: unknown-engine-test",
        "version: 0.1.0",
        `model: "anthropic:${E2E_MODEL}"`,
        "engine:",
        '  name: "nonexistent-engine"',
      ].join("\n"),
    );

    const loadResult = await loadManifest(join(dir, "koi.yaml"));
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const resolved = await resolveAgent({
      manifestPath: join(dir, "koi.yaml"),
      manifest: loadResult.value.manifest,
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;

    expect(resolved.error.message).toContain("nonexistent-engine");
  });
});
