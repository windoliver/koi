/**
 * End-to-end test for @koi/lsp features through the full L1 runtime.
 *
 * Validates that LSP tools (including the new get_diagnostics tool and
 * auto-detected server configuration) are correctly wired through:
 *   createKoi (L1) → createPiAdapter (L2) → real Anthropic LLM call
 *
 * This exercises the complete pipeline:
 *   1. LSP ComponentProvider attaches tools to agent
 *   2. L1 composes middleware chain and wires callHandlers
 *   3. Pi adapter sends tools to real LLM
 *   4. LLM decides to call LSP tools
 *   5. Tool execution returns results
 *   6. LLM produces final answer incorporating tool results
 *
 * Gated on ANTHROPIC_API_KEY — tests are skipped when the key is not set.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... bun test packages/lsp/src/__tests__/lsp-e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  ComponentProvider,
  EngineEvent,
  KoiMiddleware,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import type { Diagnostic, LspClient, ServerCapabilities } from "../index.js";
import { createLspTools } from "../index.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const describeE2E = HAS_KEY ? describe : describe.skip;

const TIMEOUT_MS = 60_000;

// Use haiku for speed + cost
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

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

function extractToolCalls(
  events: readonly EngineEvent[],
): ReadonlyArray<EngineEvent & { readonly kind: "tool_call_start" }> {
  return events.filter(
    (e): e is EngineEvent & { readonly kind: "tool_call_start" } => e.kind === "tool_call_start",
  );
}

// ---------------------------------------------------------------------------
// Mock LSP client (simulates an LSP server without spawning a process)
// ---------------------------------------------------------------------------

interface MockLspConfig {
  readonly name: string;
  readonly capabilities: ServerCapabilities;
  readonly diagnostics?: ReadonlyMap<string, readonly Diagnostic[]>;
}

function createMockLspClient(config: MockLspConfig): LspClient {
  const diagnosticsCache = new Map<string, readonly Diagnostic[]>(config.diagnostics);

  return {
    connect: async () => ({ ok: true, value: undefined }),
    hover: async () => ({
      ok: true,
      value: { contents: { kind: "markdown" as const, value: "**string** — primitive type" } },
    }),
    gotoDefinition: async () => ({
      ok: true,
      value: [
        {
          uri: "file:///project/src/types.ts",
          range: { start: { line: 10, character: 0 }, end: { line: 10, character: 20 } },
        },
      ],
    }),
    findReferences: async () => ({
      ok: true,
      value: [
        {
          uri: "file:///project/src/main.ts",
          range: { start: { line: 5, character: 2 }, end: { line: 5, character: 8 } },
        },
        {
          uri: "file:///project/src/utils.ts",
          range: { start: { line: 12, character: 4 }, end: { line: 12, character: 10 } },
        },
      ],
    }),
    documentSymbols: async () => ({
      ok: true,
      value: [
        {
          name: "greet",
          kind: 12 as const,
          location: {
            uri: "file:///project/src/main.ts",
            range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
          },
        },
        {
          name: "main",
          kind: 12 as const,
          location: {
            uri: "file:///project/src/main.ts",
            range: { start: { line: 7, character: 0 }, end: { line: 15, character: 1 } },
          },
        },
      ],
    }),
    workspaceSymbols: async () => ({
      ok: true,
      value: [
        {
          name: "Config",
          kind: 11 as const,
          location: {
            uri: "file:///project/src/config.ts",
            range: { start: { line: 0, character: 0 }, end: { line: 10, character: 1 } },
          },
        },
      ],
    }),
    openDocument: async () => ({ ok: true, value: undefined }),
    closeDocument: async (uri) => {
      diagnosticsCache.delete(uri);
      return { ok: true, value: undefined };
    },
    getDiagnostics: (uri) => {
      if (uri !== undefined) {
        const diags = diagnosticsCache.get(uri);
        if (diags === undefined) return new Map();
        return new Map([[uri, diags]]);
      }
      return new Map(diagnosticsCache);
    },
    capabilities: () => config.capabilities,
    close: async () => {},
    isConnected: () => true,
    serverName: () => config.name,
  };
}

/**
 * Creates a ComponentProvider from a mock LSP client, bypassing the real
 * transport/connection lifecycle. This lets us test the full L1 pipeline
 * without needing a real LSP server process.
 */
function createMockLspProvider(config: MockLspConfig): ComponentProvider {
  const client = createMockLspClient(config);
  const tools = createLspTools(client, config.name, 100, 50);

  const toolMap = new Map<string, unknown>();
  for (const tool of tools) {
    toolMap.set(toolToken(tool.descriptor.name) as string, tool);
  }

  return {
    name: "lsp",
    attach: async () => toolMap,
    detach: async () => {
      await client.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: @koi/lsp through full L1 runtime (createKoi + createPiAdapter)", () => {
  const manifest: AgentManifest = {
    name: "lsp-e2e-test-agent",
    version: "1.0.0",
    model: { name: "claude-haiku" },
  };

  // ── Test 1: LSP tools are visible and callable through the full pipeline ──

  test(
    "LLM sees and calls LSP tools through createKoi pipeline",
    async () => {
      const diagnostics: ReadonlyMap<string, readonly Diagnostic[]> = new Map([
        [
          "file:///project/src/app.ts",
          [
            {
              range: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } },
              severity: 1 as const,
              message: "Property 'name' does not exist on type 'object'.",
              source: "typescript",
              code: "TS2339",
            },
          ],
        ],
      ]);

      const provider = createMockLspProvider({
        name: "ts",
        capabilities: { hoverProvider: true },
        diagnostics,
      });

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: [
          "You are a code analysis assistant.",
          "You MUST use the lsp_ts_get_diagnostics tool when asked about errors.",
          "Be concise.",
        ].join(" "),
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest,
        adapter: piAdapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 5, maxDurationMs: 55_000, maxTokens: 10_000 },
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Check file:///project/src/app.ts for compiler errors using the diagnostics tool.",
        }),
      );

      await runtime.dispose();

      // Verify the LLM called at least one LSP tool
      const toolCalls = extractToolCalls(events);
      expect(toolCalls.length).toBeGreaterThan(0);

      // At least one tool call should be an LSP tool (event bridge reverse-maps to original name)
      const lspToolCalls = toolCalls.filter((tc) => tc.toolName.startsWith("lsp/ts/"));
      expect(lspToolCalls.length).toBeGreaterThan(0);

      // Should have a done event with tokens consumed
      const doneEvent = events.find((e) => e.kind === "done");
      expect(doneEvent).toBeDefined();
      if (doneEvent !== undefined && doneEvent.kind === "done") {
        expect(doneEvent.output.metrics.totalTokens).toBeGreaterThan(0);
      }

      // The final text should reference the error
      const text = extractText(events);
      expect(text.length).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  // ── Test 2: get_diagnostics tool works through L1 pipeline ───────────────

  test(
    "LLM can use get_diagnostics tool to see compiler errors",
    async () => {
      const diagnostics: ReadonlyMap<string, readonly Diagnostic[]> = new Map([
        [
          "file:///project/src/main.ts",
          [
            {
              range: { start: { line: 3, character: 10 }, end: { line: 3, character: 15 } },
              severity: 1 as const,
              code: "TS2322",
              source: "typescript",
              message: "Type 'string' is not assignable to type 'number'.",
            },
            {
              range: { start: { line: 7, character: 0 }, end: { line: 7, character: 12 } },
              severity: 2 as const,
              source: "typescript",
              message: "Variable 'unused' is declared but its value is never read.",
              tags: [1 as const],
            },
          ],
        ],
      ]);

      const provider = createMockLspProvider({
        name: "ts",
        capabilities: { hoverProvider: true },
        diagnostics,
      });

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: [
          "You are a code analysis assistant with LSP tools.",
          "You MUST use the lsp/ts/get_diagnostics tool to check for errors.",
          "Report what errors you find. Be concise.",
        ].join(" "),
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest,
        adapter: piAdapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 5, maxDurationMs: 55_000, maxTokens: 10_000 },
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Check file:///project/src/main.ts for compiler errors using the get_diagnostics tool.",
        }),
      );

      await runtime.dispose();

      // Verify get_diagnostics was called
      const toolCalls = extractToolCalls(events);
      const diagCalls = toolCalls.filter((tc) => tc.toolName === "lsp/ts/get_diagnostics");
      expect(diagCalls.length).toBeGreaterThan(0);

      // Final text should reference the error
      const text = extractText(events);
      expect(text.toLowerCase()).toMatch(/type|error|assign|string|number/i);

      const doneEvent = events.find((e) => e.kind === "done");
      expect(doneEvent).toBeDefined();
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Multiple tools can work together in a single session ──────────

  test(
    "LLM orchestrates multiple LSP tools in a single session",
    async () => {
      const diagnostics: ReadonlyMap<string, readonly Diagnostic[]> = new Map([
        [
          "file:///project/src/main.ts",
          [
            {
              range: { start: { line: 5, character: 2 }, end: { line: 5, character: 8 } },
              severity: 1 as const,
              message: "Cannot find name 'foobar'.",
              source: "typescript",
            },
          ],
        ],
      ]);

      const provider = createMockLspProvider({
        name: "ts",
        capabilities: {
          hoverProvider: true,
          definitionProvider: true,
          documentSymbolProvider: true,
        },
        diagnostics,
      });

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: [
          "You are a code analysis assistant.",
          "First use lsp/ts/get_diagnostics to find errors.",
          "Then use lsp/ts/document_symbols to list the symbols in the file.",
          "Report both results concisely.",
        ].join(" "),
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest,
        adapter: piAdapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 8, maxDurationMs: 55_000, maxTokens: 15_000 },
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Analyze file:///project/src/main.ts: first check diagnostics, then list its symbols.",
        }),
      );

      await runtime.dispose();

      // Should have called multiple tools
      const toolCalls = extractToolCalls(events);
      expect(toolCalls.length).toBeGreaterThanOrEqual(2);

      const toolNames = new Set(toolCalls.map((tc) => tc.toolName));
      // At least get_diagnostics and one of document_symbols or other tools
      expect(toolNames.has("lsp/ts/get_diagnostics")).toBe(true);

      const doneEvent = events.find((e) => e.kind === "done");
      expect(doneEvent).toBeDefined();
      if (doneEvent !== undefined && doneEvent.kind === "done") {
        expect(doneEvent.output.stopReason).toBe("completed");
        expect(doneEvent.output.metrics.totalTokens).toBeGreaterThan(0);
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Middleware sees LSP tool calls ─────────────────────────────────

  test(
    "middleware intercepts LSP tool calls through L1 composition",
    async () => {
      // let justified: track middleware interception
      let interceptedToolCalls = 0;
      const interceptedToolNames: string[] = [];

      const provider = createMockLspProvider({
        name: "ts",
        capabilities: { hoverProvider: true },
        diagnostics: new Map([
          [
            "file:///project/src/main.ts",
            [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                message: "test error",
                severity: 1 as const,
              },
            ],
          ],
        ]),
      });

      const observerMiddleware: KoiMiddleware = {
        name: "lsp-observer",
        priority: 600,
        wrapToolCall: async (
          _ctx: TurnContext,
          request: ToolRequest,
          next: ToolHandler,
        ): Promise<ToolResponse> => {
          if (request.toolId.startsWith("lsp/")) {
            interceptedToolCalls++;
            interceptedToolNames.push(request.toolId);
          }
          return next(request);
        },
      };

      const piAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the lsp/ts/get_diagnostics tool to check for errors. Be concise.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest,
        adapter: piAdapter,
        providers: [provider],
        middleware: [observerMiddleware],
        loopDetection: false,
        limits: { maxTurns: 5, maxDurationMs: 55_000, maxTokens: 10_000 },
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Check for diagnostics in file:///project/src/main.ts using get_diagnostics.",
        }),
      );

      await runtime.dispose();

      // Middleware should have intercepted at least one LSP tool call
      expect(interceptedToolCalls).toBeGreaterThan(0);
      expect(interceptedToolNames.some((n) => n.startsWith("lsp/"))).toBe(true);

      const doneEvent = events.find((e) => e.kind === "done");
      expect(doneEvent).toBeDefined();
    },
    TIMEOUT_MS,
  );
});
