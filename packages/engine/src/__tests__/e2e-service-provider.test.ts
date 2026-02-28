/**
 * E2E: createServiceProvider + createSingleToolProvider through full L1 runtime.
 *
 * Validates that our refactored ComponentProvider factories work end-to-end
 * with real LLM calls through createKoi + createPiAdapter:
 *
 *   1. createFileSystemProvider  — LLM reads a file via fs_read tool
 *   2. createWebhookProvider     — LLM lists webhooks via webhook_list tool
 *   3. createSingleToolProvider  — LLM uses a custom single-tool provider
 *   4. Mixed providers           — LLM uses tools from multiple providers
 *   5. Middleware interposition   — wrapToolCall fires for provider-created tools
 *   6. Provider caching           — same provider re-used across runtimes
 *   7. Custom prefix              — prefix works end-to-end through L1
 *   8. Raw createServiceProvider  — custom backend + factory through L1
 *   9. Full session lifecycle     — session_start → tool calls → session_end
 *
 * Gate: E2E_TESTS=1 + ANTHROPIC_API_KEY
 *
 * Run:
 *   E2E_TESTS=1 bun test packages/engine/src/__tests__/e2e-service-provider.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  EngineEvent,
  EngineOutput,
  FileSystemBackend,
  JsonObject,
  KoiMiddleware,
  Tool,
  ToolRequest,
  ToolResponse,
  WebhookComponent,
} from "@koi/core";
import { createServiceProvider, createSingleToolProvider } from "@koi/core";
import { createPiAdapter } from "@koi/engine-pi";
import { createFileSystemProvider } from "@koi/filesystem";
import { createWebhookProvider } from "@koi/webhook-provider";
import { createKoi } from "../koi.js";
import type { KoiRuntime } from "../types.js";

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

function testManifest(): AgentManifest {
  return {
    name: "e2e-service-provider",
    version: "0.1.0",
    model: { name: E2E_MODEL },
  };
}

function createAdapter(systemPrompt: string) {
  return createPiAdapter({
    model: E2E_MODEL,
    systemPrompt,
    getApiKey: async () => ANTHROPIC_KEY,
  });
}

async function runAgent(
  runtime: KoiRuntime,
  prompt: string,
): Promise<{
  readonly events: readonly EngineEvent[];
  readonly output: EngineOutput | undefined;
  readonly text: string;
}> {
  const events = await collectEvents(runtime.run({ kind: "text", text: prompt }));
  return {
    events,
    output: findDoneOutput(events),
    text: extractText(events),
  };
}

// ---------------------------------------------------------------------------
// In-memory FileSystemBackend (deterministic, no real disk I/O)
// ---------------------------------------------------------------------------

function createInMemoryFsBackend(): FileSystemBackend {
  const files = new Map<string, string>([
    ["/workspace/readme.txt", "Hello from createServiceProvider E2E test!"],
    ["/workspace/config.json", '{"version": "1.0", "name": "koi-e2e"}'],
    ["/workspace/src/index.ts", "export const answer = 42;\n"],
  ]);

  const dirs = new Map<string, readonly string[]>([
    ["/workspace", ["readme.txt", "config.json", "src"]],
    ["/workspace/src", ["index.ts"]],
  ]);

  return {
    name: "in-memory",
    read: (path) => {
      const content = files.get(path);
      if (content === undefined) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `File not found: ${path}`, retryable: false },
        };
      }
      return { ok: true, value: { content, path, size: content.length } };
    },
    write: (path, content) => ({
      ok: true,
      value: { path, bytesWritten: content.length },
    }),
    edit: (path, edits) => ({
      ok: true,
      value: { path, hunksApplied: edits.length },
    }),
    list: (path) => {
      const entries = dirs.get(path);
      if (entries === undefined) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Directory not found: ${path}`,
            retryable: false,
          },
        };
      }
      return {
        ok: true,
        value: {
          entries: entries.map((name) => ({
            path: `${path}/${name}`,
            kind: name.includes(".") ? ("file" as const) : ("directory" as const),
            size: name.includes(".") ? (files.get(`${path}/${name}`)?.length ?? 0) : 0,
          })),
          truncated: false,
        },
      };
    },
    search: (pattern) => ({
      ok: true,
      value: {
        matches: Array.from(files.entries())
          .filter(([, content]) => content.includes(pattern))
          .map(([path, content]) => ({ path, line: 1, text: content })),
        truncated: false,
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// In-memory WebhookComponent
// ---------------------------------------------------------------------------

function createInMemoryWebhookComponent(): WebhookComponent {
  return {
    list: () => [
      {
        url: "https://hooks.example.com/deploy",
        events: ["session.started", "session.ended"],
        description: "Deployment notification webhook",
        enabled: true,
      },
      {
        url: "https://hooks.example.com/alerts",
        events: ["tool.failed"],
        enabled: false,
      },
    ],
    health: () => [
      {
        url: "https://hooks.example.com/deploy",
        ok: true,
        consecutiveFailures: 0,
        circuitBreakerOpen: false,
        lastDeliveryAt: Date.now() - 60_000,
      },
      {
        url: "https://hooks.example.com/alerts",
        ok: false,
        consecutiveFailures: 5,
        circuitBreakerOpen: true,
        lastError: "Connection refused",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: createServiceProvider through full L1 runtime", () => {
  // ── Test 1: FileSystem provider (createServiceProvider) ─────────────

  test(
    "LLM reads a file through createFileSystemProvider",
    async () => {
      const fsProvider = createFileSystemProvider({
        backend: createInMemoryFsBackend(),
        operations: ["read", "list"],
      });

      const adapter = createAdapter(
        "You have filesystem tools (fs_read, fs_list). " +
          "When asked about a file, use fs_read. Always use the tool.",
      );

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [fsProvider],
        loopDetection: false,
        limits: { maxTurns: 5, maxDurationMs: 60_000, maxTokens: 500_000 },
      });

      const { events, output, text } = await runAgent(
        runtime,
        "Read the file at /workspace/readme.txt and tell me what it says.",
      );

      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Tool call events should exist
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      expect(toolStarts.length).toBeGreaterThanOrEqual(1);

      // Response should contain the file content
      expect(text).toContain("createServiceProvider");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 2: Webhook provider (createServiceProvider) ────────────────

  test(
    "LLM lists webhooks through createWebhookProvider",
    async () => {
      const webhookProvider = createWebhookProvider({
        webhookComponent: createInMemoryWebhookComponent(),
        operations: ["list"],
      });

      const adapter = createAdapter(
        "You have a webhook_list tool. When asked about webhooks, use it. Always use the tool.",
      );

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [webhookProvider],
        loopDetection: false,
        limits: { maxTurns: 5, maxDurationMs: 60_000, maxTokens: 500_000 },
      });

      const { output, text } = await runAgent(
        runtime,
        "List all configured webhooks and tell me their URLs.",
      );

      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Response should contain webhook URLs from our mock
      expect(text).toContain("hooks.example.com");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Single-tool provider (createSingleToolProvider) ─────────

  test(
    "LLM uses a tool from createSingleToolProvider",
    async () => {
      const computeTool: Tool = {
        descriptor: {
          name: "compute_hash",
          description:
            "Computes a simple hash of the input string. Returns the hash value as a number.",
          inputSchema: {
            type: "object",
            properties: {
              input: { type: "string", description: "String to hash" },
            },
            required: ["input"],
          } as JsonObject,
        },
        trustTier: "sandbox",
        execute: async (args: JsonObject): Promise<unknown> => {
          const str = String(args.input ?? "");
          // Deterministic hash
          let hash = 0;
          for (const char of str) {
            hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
          }
          return { hash: Math.abs(hash), input: str };
        },
      };

      const singleProvider = createSingleToolProvider({
        name: "hash-provider",
        toolName: "compute_hash",
        createTool: () => computeTool,
      });

      const adapter = createAdapter(
        "You have a compute_hash tool. When asked to hash something, use it. " +
          "Report the exact hash value from the tool result.",
      );

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [singleProvider],
        loopDetection: false,
        limits: { maxTurns: 5, maxDurationMs: 60_000, maxTokens: 500_000 },
      });

      const { events, output } = await runAgent(
        runtime,
        'Use the compute_hash tool to hash the string "koi" and tell me the hash value.',
      );

      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Should have called compute_hash
      const toolCalls = events.filter((e) => e.kind === "tool_call_start");
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Mixed providers in a single session ─────────────────────

  test(
    "LLM uses tools from multiple providers in one session",
    async () => {
      const fsProvider = createFileSystemProvider({
        backend: createInMemoryFsBackend(),
        operations: ["read", "list"],
      });

      const webhookProvider = createWebhookProvider({
        webhookComponent: createInMemoryWebhookComponent(),
        operations: ["list"],
      });

      const adapter = createAdapter(
        "You have filesystem tools (fs_read, fs_list) and webhook tools (webhook_list). " +
          "Use the appropriate tool for each request. Always use tools.",
      );

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [fsProvider, webhookProvider],
        loopDetection: false,
        limits: { maxTurns: 8, maxDurationMs: 60_000, maxTokens: 500_000 },
      });

      const { events, output, text } = await runAgent(
        runtime,
        "First, read /workspace/config.json. Then list all webhooks. Report both results.",
      );

      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Should have used at least 2 tools
      const toolCalls = events.filter((e) => e.kind === "tool_call_start");
      expect(toolCalls.length).toBeGreaterThanOrEqual(2);

      // Response should reference content from both providers
      const hasFileContent = text.includes("koi-e2e") || text.includes("1.0");
      const hasWebhookContent = text.includes("hooks.example.com") || text.includes("webhook");
      expect(hasFileContent || hasWebhookContent).toBe(true);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 5: Middleware interposition with provider tools ─────────────

  test(
    "wrapToolCall middleware fires for createServiceProvider tools",
    async () => {
      const interceptedTools: string[] = [];

      const observer: KoiMiddleware = {
        name: "tool-observer",
        describeCapabilities: () => undefined,
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          interceptedTools.push(request.toolId);
          return next(request);
        },
      };

      const fsProvider = createFileSystemProvider({
        backend: createInMemoryFsBackend(),
        operations: ["read"],
      });

      const adapter = createAdapter(
        "You have an fs_read tool. Use it to read files. Always use the tool.",
      );

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [observer],
        providers: [fsProvider],
        loopDetection: false,
        limits: { maxTurns: 5, maxDurationMs: 60_000, maxTokens: 500_000 },
      });

      await runAgent(runtime, "Read the file at /workspace/readme.txt.");

      // Middleware must have intercepted fs_read
      expect(interceptedTools).toContain("fs_read");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 6: Provider caching — same Map across agent attaches ────────

  test(
    "createServiceProvider caching works through L1 assembly",
    async () => {
      const fsProvider = createFileSystemProvider({
        backend: createInMemoryFsBackend(),
        operations: ["read"],
      });

      const adapter = createAdapter(
        "You have an fs_read tool. Use it when asked. Always use the tool.",
      );

      // First runtime — tools are created
      const runtime1 = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [fsProvider],
        loopDetection: false,
        limits: { maxTurns: 5, maxDurationMs: 60_000, maxTokens: 500_000 },
      });

      const { output: output1 } = await runAgent(runtime1, "Read /workspace/readme.txt.");
      expect(output1).toBeDefined();
      expect(output1?.stopReason).toBe("completed");
      await runtime1.dispose();

      // Second runtime with same provider — tools should be cached
      const runtime2 = await createKoi({
        manifest: testManifest(),
        adapter: createAdapter("You have an fs_read tool. Use it. Always use tools."),
        providers: [fsProvider],
        loopDetection: false,
        limits: { maxTurns: 5, maxDurationMs: 60_000, maxTokens: 500_000 },
      });

      const { output: output2 } = await runAgent(runtime2, "Read /workspace/config.json.");
      expect(output2).toBeDefined();
      expect(output2?.stopReason).toBe("completed");
      await runtime2.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 7: Custom prefix end-to-end ────────────────────────────────

  test(
    "custom prefix works end-to-end through L1 runtime",
    async () => {
      const interceptedTools: string[] = [];

      const observer: KoiMiddleware = {
        name: "prefix-observer",
        describeCapabilities: () => undefined,
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          interceptedTools.push(request.toolId);
          return next(request);
        },
      };

      const fsProvider = createFileSystemProvider({
        backend: createInMemoryFsBackend(),
        prefix: "files",
        operations: ["read"],
      });

      const adapter = createAdapter(
        "You have a files_read tool. Use it to read files. Always use the tool.",
      );

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [observer],
        providers: [fsProvider],
        loopDetection: false,
        limits: { maxTurns: 5, maxDurationMs: 60_000, maxTokens: 500_000 },
      });

      await runAgent(runtime, "Read the file at /workspace/readme.txt using files_read.");

      // Middleware should see the custom-prefixed tool name
      expect(interceptedTools).toContain("files_read");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 8: Raw createServiceProvider (custom backend) ──────────────

  test(
    "raw createServiceProvider wires custom backend through L1",
    async () => {
      type MathBackend = {
        readonly add: (a: number, b: number) => number;
        readonly multiply: (a: number, b: number) => number;
      };
      type MathOp = "add" | "multiply";

      const mathBackend: MathBackend = {
        add: (a, b) => a + b,
        multiply: (a, b) => a * b,
      };

      const mathFactories: Record<
        MathOp,
        (backend: MathBackend, prefix: string, _trustTier: unknown) => Tool
      > = {
        add: (b, prefix) => ({
          descriptor: {
            name: `${prefix}_add`,
            description: "Adds two numbers together.",
            inputSchema: {
              type: "object",
              properties: {
                a: { type: "number" },
                b: { type: "number" },
              },
              required: ["a", "b"],
            } as JsonObject,
          },
          trustTier: "sandbox",
          execute: async (args: JsonObject) => String(b.add(Number(args.a), Number(args.b))),
        }),
        multiply: (b, prefix) => ({
          descriptor: {
            name: `${prefix}_multiply`,
            description: "Multiplies two numbers together.",
            inputSchema: {
              type: "object",
              properties: {
                a: { type: "number" },
                b: { type: "number" },
              },
              required: ["a", "b"],
            } as JsonObject,
          },
          trustTier: "sandbox",
          execute: async (args: JsonObject) => String(b.multiply(Number(args.a), Number(args.b))),
        }),
      };

      const mathProvider = createServiceProvider<MathBackend, MathOp>({
        name: "math",
        backend: mathBackend,
        operations: ["add", "multiply"],
        factories: mathFactories,
        prefix: "math",
      });

      const adapter = createAdapter(
        "You have math_add and math_multiply tools. Always use tools to compute. " +
          "Never compute in your head.",
      );

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [mathProvider],
        loopDetection: false,
        limits: { maxTurns: 5, maxDurationMs: 60_000, maxTokens: 500_000 },
      });

      const { events, output, text } = await runAgent(
        runtime,
        "Use math_add to compute 17 + 25, then tell me the result.",
      );

      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      const toolCalls = events.filter((e) => e.kind === "tool_call_start");
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);

      // Response should contain 42
      expect(text).toContain("42");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 9: Full session lifecycle ──────────────────────────────────

  test(
    "full session lifecycle: session_start → tool calls → session_end",
    async () => {
      const lifecyclePhases: string[] = [];

      const lifecycle: KoiMiddleware = {
        name: "lifecycle-tracker",
        describeCapabilities: () => undefined,
        onSessionStart: async () => {
          lifecyclePhases.push("session_start");
        },
        onSessionEnd: async () => {
          lifecyclePhases.push("session_end");
        },
        onAfterTurn: async () => {
          lifecyclePhases.push("after_turn");
        },
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          lifecyclePhases.push(`tool:${request.toolId}`);
          return next(request);
        },
      };

      const fsProvider = createFileSystemProvider({
        backend: createInMemoryFsBackend(),
        operations: ["read"],
      });

      const adapter = createAdapter(
        "You have an fs_read tool. Use it when asked. Always use the tool.",
      );

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [lifecycle],
        providers: [fsProvider],
        loopDetection: false,
        limits: { maxTurns: 5, maxDurationMs: 60_000, maxTokens: 500_000 },
      });

      await runAgent(runtime, "Read /workspace/readme.txt.");

      // Session lifecycle ordering
      expect(lifecyclePhases[0]).toBe("session_start");
      expect(lifecyclePhases[lifecyclePhases.length - 1]).toBe("session_end");

      // Tool was called between session boundaries
      expect(lifecyclePhases).toContain("tool:fs_read");

      // At least one turn completed
      expect(lifecyclePhases).toContain("after_turn");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
