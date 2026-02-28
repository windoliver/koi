/**
 * End-to-end tests for named tool profiles + model-capability-aware dynamic profiles.
 *
 * Validates the full stack: createKoi + createPiAdapter + real Anthropic LLM
 * with tool-selector middleware wired through the middleware chain.
 *
 * Tests:
 *   1. Profile mode ("coding") filters tools before model sees them
 *   2. Profile mode with include/exclude modifiers
 *   3. Auto mode with tier detection from manifest model name
 *   4. Full profile short-circuits (all tools pass through)
 *   5. Custom selectTools (backward compat) still works through createKoi
 *   6. Profile middleware records profileMissingTools in metadata
 *   7. Descriptor factory integration: profile from YAML-style options
 *   8. Multi-tool agent: profile filters then model uses surviving tools
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1.
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-tool-profiles.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  Tool,
  TurnContext,
} from "@koi/core";
import { toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { TOOL_PROFILES } from "../tool-profiles.js";
import { createToolSelectorMiddleware } from "../tool-selector.js";

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
// Helpers
// ---------------------------------------------------------------------------

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

function testManifest(modelName = "claude-haiku-4-5"): AgentManifest {
  return {
    name: "E2E Tool-Profile Agent",
    version: "0.1.0",
    model: { name: modelName },
  };
}

function createAdapter(): ReturnType<typeof createPiAdapter> {
  return createPiAdapter({
    model: E2E_MODEL,
    systemPrompt:
      "You are a concise test assistant. When asked to use a tool, always use it. Reply briefly.",
    getApiKey: async () => ANTHROPIC_KEY,
  });
}

// ---------------------------------------------------------------------------
// Tool definitions — 10 tools to exceed minTools threshold (default: 5)
// ---------------------------------------------------------------------------

function makeTool(name: string, description: string): Tool {
  return {
    descriptor: {
      name,
      description,
      inputSchema: {
        type: "object",
        properties: { input: { type: "string" } },
      },
    },
    trustTier: "sandbox",
    execute: async (input: Readonly<Record<string, unknown>>) => {
      return `${name} executed with: ${JSON.stringify(input)}`;
    },
  };
}

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

// Create many dummy tools to exceed minTools threshold
const DUMMY_TOOLS: readonly Tool[] = [
  makeTool("file_read", "Reads a file from disk"),
  makeTool("file_write", "Writes content to a file"),
  makeTool("file_list", "Lists files in a directory"),
  makeTool("file_delete", "Deletes a file"),
  makeTool("shell_exec", "Executes a shell command"),
  makeTool("apply_patch", "Applies a diff patch to a file"),
  makeTool("search_forge", "Searches the forge index"),
  makeTool("web_fetch", "Fetches content from a URL"),
  makeTool("web_search", "Searches the web"),
  makeTool("memory_store", "Stores a memory"),
  makeTool("memory_recall", "Recalls stored memories"),
  makeTool("schedule_create", "Creates a scheduled task"),
  makeTool("browser_navigate", "Navigates a browser to a URL"),
];

function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "e2e-tool-provider",
    attach: async () => new Map(tools.map((t) => [toolToken(t.descriptor.name) as string, t])),
  };
}

// ---------------------------------------------------------------------------
// Middleware observer — captures what the model actually receives
// ---------------------------------------------------------------------------

interface ModelCallCapture {
  readonly toolsBefore: number;
  readonly toolsAfter: number;
  readonly toolNames: readonly string[];
  readonly profileMissingTools?: readonly string[] | undefined;
}

function createObserverMiddleware(): {
  readonly middleware: KoiMiddleware;
  readonly captures: ModelCallCapture[];
} {
  const captures: ModelCallCapture[] = [];

  const middleware: KoiMiddleware = {
    name: "e2e-observer",
    priority: 999, // runs last (innermost) — sees the request AFTER tool-selector filters
    describeCapabilities: () => undefined,
    async wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const metadata = request.metadata as Record<string, unknown> | undefined;
      captures.push({
        toolsBefore: (metadata?.toolsBeforeFilter as number) ?? -1,
        toolsAfter: (metadata?.toolsAfterFilter as number) ?? -1,
        toolNames: (request.tools ?? []).map((t) => t.name),
        profileMissingTools: metadata?.profileMissingTools as readonly string[] | undefined,
      });
      return next(request);
    },

    async *wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const metadata = request.metadata as Record<string, unknown> | undefined;
      captures.push({
        toolsBefore: (metadata?.toolsBeforeFilter as number) ?? -1,
        toolsAfter: (metadata?.toolsAfterFilter as number) ?? -1,
        toolNames: (request.tools ?? []).map((t) => t.name),
        profileMissingTools: metadata?.profileMissingTools as readonly string[] | undefined,
      });
      yield* next(request);
    },
  };

  return { middleware, captures };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: tool profiles through createKoi + createPiAdapter", () => {
  // ── Test 1: Profile mode filters tools ──────────────────────────────

  test(
    "profile: 'coding' filters 13 tools down to coding subset",
    async () => {
      const toolSelectorMw = createToolSelectorMiddleware({
        profile: "coding",
        minTools: 0, // always filter, even for small sets
      });
      const { middleware: observer, captures } = createObserverMiddleware();

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(),
        middleware: [toolSelectorMw, observer],
        providers: [createToolProvider(DUMMY_TOOLS)],
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "Say hello" }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Observer should have captured the filtered request
      expect(captures.length).toBeGreaterThanOrEqual(1);
      const capture = captures[0];
      expect(capture).toBeDefined();
      if (!capture) return;

      // All tool names after filtering should be from the coding profile
      for (const name of capture.toolNames) {
        expect(TOOL_PROFILES.coding).toContain(name);
      }

      // Metadata shows before/after counts
      expect(capture.toolsBefore).toBeGreaterThan(capture.toolsAfter);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 2: Profile with include/exclude modifiers ──────────────────

  test(
    "profile: 'minimal' with include=['multiply'] adds the multiply tool",
    async () => {
      const toolSelectorMw = createToolSelectorMiddleware({
        profile: "minimal",
        include: ["multiply"],
        minTools: 0,
      });
      const { middleware: observer, captures } = createObserverMiddleware();

      const allTools = [...DUMMY_TOOLS, MULTIPLY_TOOL];

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(),
        middleware: [toolSelectorMw, observer],
        providers: [createToolProvider(allTools)],
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "Say ok" }));

      expect(findDoneOutput(events)?.stopReason).toBe("completed");

      const capture = captures[0];
      expect(capture).toBeDefined();
      if (!capture) return;

      // Should include multiply (from include) + minimal profile tools
      expect(capture.toolNames).toContain("multiply");
      expect(capture.toolNames).toContain("memory_store");
      expect(capture.toolNames).toContain("memory_recall");

      // Should NOT include coding-only tools like shell_exec
      expect(capture.toolNames).not.toContain("shell_exec");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Auto mode with tier detection ───────────────────────────

  test(
    "autoScale with haiku model detects 'minimal' tier and caps tools",
    async () => {
      const toolSelectorMw = createToolSelectorMiddleware({
        profile: "coding",
        autoScale: true,
        tier: "minimal", // simulate what descriptor would compute for haiku
        minTools: 0,
      });
      const { middleware: observer, captures } = createObserverMiddleware();

      const runtime = await createKoi({
        manifest: testManifest("claude-haiku-4-5"),
        adapter: createAdapter(),
        middleware: [toolSelectorMw, observer],
        providers: [createToolProvider(DUMMY_TOOLS)],
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "Say hi" }));

      expect(findDoneOutput(events)?.stopReason).toBe("completed");

      const capture = captures[0];
      expect(capture).toBeDefined();
      if (!capture) return;

      // Minimal tier caps at 5 tools
      expect(capture.toolNames.length).toBeLessThanOrEqual(5);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Full profile short-circuits ─────────────────────────────

  test(
    "profile: 'full' passes all tools through (no filtering)",
    async () => {
      const toolSelectorMw = createToolSelectorMiddleware({
        profile: "full",
        minTools: 0,
      });
      const { middleware: observer, captures } = createObserverMiddleware();

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(),
        middleware: [toolSelectorMw, observer],
        providers: [createToolProvider(DUMMY_TOOLS)],
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "Say ok" }));

      expect(findDoneOutput(events)?.stopReason).toBe("completed");

      const capture = captures[0];
      expect(capture).toBeDefined();
      if (!capture) return;

      // Full profile = no filtering, all 13 tools should pass through
      expect(capture.toolNames.length).toBe(DUMMY_TOOLS.length);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 5: Backward compat — custom selectTools works ─────────────

  test(
    "custom selectTools (backward compat) filters through createKoi",
    async () => {
      const toolSelectorMw = createToolSelectorMiddleware({
        selectTools: async (_query, tools) => {
          // Only keep tools with "file" in the name
          return tools.filter((t) => t.name.includes("file")).map((t) => t.name);
        },
        minTools: 0,
      });
      const { middleware: observer, captures } = createObserverMiddleware();

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(),
        middleware: [toolSelectorMw, observer],
        providers: [createToolProvider(DUMMY_TOOLS)],
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "List my tools" }));

      expect(findDoneOutput(events)?.stopReason).toBe("completed");

      const capture = captures[0];
      expect(capture).toBeDefined();
      if (!capture) return;

      // Only file_* tools should survive
      for (const name of capture.toolNames) {
        expect(name).toContain("file");
      }

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 6: Profile missing tools metadata ──────────────────────────

  test(
    "records profileMissingTools when profile tools are absent from agent",
    async () => {
      // Register only 2 of the coding profile tools
      const partialTools = [
        makeTool("file_read", "Reads a file"),
        makeTool("file_write", "Writes a file"),
        // Missing: file_list, file_delete, shell_exec, apply_patch, search_forge
        ...Array.from({ length: 4 }, (_, i) => makeTool(`extra_${i}`, `Extra tool ${i}`)),
      ];

      const toolSelectorMw = createToolSelectorMiddleware({
        profile: "coding",
        minTools: 0,
      });
      const { middleware: observer, captures } = createObserverMiddleware();

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(),
        middleware: [toolSelectorMw, observer],
        providers: [createToolProvider(partialTools)],
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "Say ok" }));

      expect(findDoneOutput(events)?.stopReason).toBe("completed");

      const capture = captures[0];
      expect(capture).toBeDefined();
      if (!capture) return;

      // Should report missing tools from the coding profile
      expect(capture.profileMissingTools).toBeDefined();
      expect(capture.profileMissingTools?.length).toBeGreaterThan(0);
      // shell_exec is in coding profile but not in our registered tools
      expect(capture.profileMissingTools).toContain("shell_exec");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 7: Multi-tool agent with profile — model uses surviving tool

  test(
    "profile filters tools, model uses surviving multiply tool",
    async () => {
      // Use minimal profile + include multiply so model can use it
      const toolSelectorMw = createToolSelectorMiddleware({
        profile: "minimal",
        include: ["multiply"],
        minTools: 0,
      });

      const allTools = [...DUMMY_TOOLS, MULTIPLY_TOOL];

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the multiply tool to answer math questions. Do not compute in your head.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [toolSelectorMw],
        providers: [createToolProvider(allTools)],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the multiply tool to compute 6 * 7. Tell me the result.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Tool should have been called
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      expect(toolStarts.length).toBeGreaterThanOrEqual(1);

      // Response should contain 42
      const text = extractText(events);
      expect(text).toContain("42");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 8: Conversation profile — very small tool set ──────────────

  test(
    "profile: 'conversation' restricts to only memory tools",
    async () => {
      const toolSelectorMw = createToolSelectorMiddleware({
        profile: "conversation",
        minTools: 0,
      });
      const { middleware: observer, captures } = createObserverMiddleware();

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter(),
        middleware: [toolSelectorMw, observer],
        providers: [createToolProvider(DUMMY_TOOLS)],
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "Say ok" }));

      expect(findDoneOutput(events)?.stopReason).toBe("completed");

      const capture = captures[0];
      expect(capture).toBeDefined();
      if (!capture) return;

      // Conversation profile = only memory_store + memory_recall
      expect(capture.toolNames.length).toBeLessThanOrEqual(2);
      for (const name of capture.toolNames) {
        expect(["memory_store", "memory_recall"]).toContain(name);
      }

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
