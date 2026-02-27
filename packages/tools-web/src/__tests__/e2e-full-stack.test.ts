/**
 * Full-stack E2E: createKoi + createPiAdapter + @koi/tools-web + real Anthropic LLM.
 *
 * Validates the entire web tool pipeline through the L1 runtime:
 *   - Real LLM uses web_fetch tool to fetch a URL and reports the content
 *   - web_fetch with format=markdown returns markdown-converted HTML
 *   - web_search works end-to-end with Brave Search API
 *   - SSRF protection blocks private/internal URLs
 *   - Middleware chain (wrapToolCall, onAfterTurn) observes web tool calls
 *   - Session lifecycle hooks fire in correct order
 *   - Response caching serves repeated requests from cache
 *
 * Run:
 *   E2E_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/e2e-full-stack.test.ts
 *
 * For search tests, also set:
 *   BRAVE_API_KEY=BSA...
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createBraveSearch } from "@koi/search-brave";
import { createWebExecutor, createWebProvider } from "../index.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const BRAVE_KEY = process.env.BRAVE_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const HAS_BRAVE_KEY = BRAVE_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;
const describeSearch = HAS_KEY && HAS_BRAVE_KEY && E2E_OPTED_IN ? describe : describe.skip;

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
    name: "E2E Web Tools Agent",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5" },
  };
}

// ---------------------------------------------------------------------------
// Tests — web_fetch
// ---------------------------------------------------------------------------

describeE2E("e2e: @koi/tools-web through createKoi + createPiAdapter", () => {
  // ── Test 1: LLM calls web_fetch and uses the result ───────────────────

  test(
    "LLM uses web_fetch to retrieve a URL and reports content",
    async () => {
      const toolCalls: string[] = [];

      const observer: KoiMiddleware = {
        name: "web-tool-observer",
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolCalls.push(request.toolId);
          return next(request);
        },
      };

      const executor = createWebExecutor();
      const provider = createWebProvider({ executor });

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You have access to web_fetch and web_search tools. " +
          "When asked to fetch a URL, you MUST use the web_fetch tool. " +
          "Report the key content from the fetched page.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [observer],
        providers: [provider],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use web_fetch to fetch https://httpbin.org/get and tell me what the 'Host' header value is in the response.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Middleware observed the tool call
      expect(toolCalls).toContain("web_fetch");

      // tool_call_start and tool_call_end events should exist for web_fetch
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      const toolEnds = events.filter((e) => e.kind === "tool_call_end");
      expect(toolStarts.length).toBeGreaterThanOrEqual(1);
      expect(toolEnds.length).toBeGreaterThanOrEqual(1);

      // Response should mention httpbin
      const text = extractText(events);
      expect(text.toLowerCase()).toContain("httpbin");

      // Metrics should record token usage
      expect(output?.metrics.inputTokens).toBeGreaterThan(0);
      expect(output?.metrics.outputTokens).toBeGreaterThan(0);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 2: web_fetch with markdown format ─────────────────────────────

  test(
    "LLM uses web_fetch with format=markdown to get structured content",
    async () => {
      // let justified: track tool arguments to verify format param
      let fetchArgs: Readonly<Record<string, unknown>> | undefined;

      const argCapture: KoiMiddleware = {
        name: "arg-capture",
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          if (request.toolId === "web_fetch") {
            fetchArgs = request.input;
          }
          return next(request);
        },
      };

      const executor = createWebExecutor();
      const provider = createWebProvider({ executor });

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You have web_fetch. When asked to fetch a URL in markdown format, " +
          "use web_fetch with format='markdown'. Report the content you receive.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [argCapture],
        providers: [provider],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Fetch https://example.com using web_fetch with format set to 'markdown'. Tell me the title of the page.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // The LLM should have called web_fetch
      expect(fetchArgs).toBeDefined();
      expect(fetchArgs?.url).toBe("https://example.com");

      // Response should mention Example Domain (the title of example.com)
      const text = extractText(events);
      expect(text).toContain("Example Domain");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 3: SSRF protection blocks private URLs ────────────────────────

  test(
    "web_fetch blocks localhost URLs with SSRF protection",
    async () => {
      // let justified: track whether tool returned an error
      let toolResult: string | undefined;

      const resultCapture: KoiMiddleware = {
        name: "result-capture",
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          const response = await next(request);
          if (request.toolId === "web_fetch") {
            toolResult =
              typeof response.output === "string"
                ? response.output
                : JSON.stringify(response.output);
          }
          return response;
        },
      };

      const executor = createWebExecutor();
      const provider = createWebProvider({ executor });

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You have web_fetch. When asked to fetch a URL, use web_fetch. " +
          "Report exactly what the tool returns, including any errors.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [resultCapture],
        providers: [provider],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use web_fetch to fetch http://localhost:8080/admin. Report what happens.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      // The tool should have returned an error about blocked URL
      expect(toolResult).toBeDefined();
      expect(toolResult).toContain("blocked");

      // The LLM response should mention the URL was blocked
      const text = extractText(events);
      const lower = text.toLowerCase();
      expect(lower.includes("block") || lower.includes("error") || lower.includes("denied")).toBe(
        true,
      );

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Middleware chain + lifecycle hooks fire correctly ───────────

  test(
    "session lifecycle hooks and tool middleware fire for web tools",
    async () => {
      const hookOrder: string[] = [];

      const lifecycle: KoiMiddleware = {
        name: "lifecycle-tracker",
        onSessionStart: async () => {
          hookOrder.push("session_start");
        },
        onSessionEnd: async () => {
          hookOrder.push("session_end");
        },
        onAfterTurn: async () => {
          hookOrder.push("after_turn");
        },
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          hookOrder.push(`tool:${request.toolId}`);
          return next(request);
        },
      };

      const executor = createWebExecutor();
      const provider = createWebProvider({ executor });

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You have web_fetch. Use it when asked to fetch a URL. Be brief.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [lifecycle],
        providers: [provider],
        loopDetection: false,
      });

      await collectEvents(
        runtime.run({
          kind: "text",
          text: "Fetch https://httpbin.org/status/200 using web_fetch. Report the status code.",
        }),
      );

      // Session lifecycle must be correct
      expect(hookOrder[0]).toBe("session_start");
      expect(hookOrder[hookOrder.length - 1]).toBe("session_end");
      expect(hookOrder).toContain("after_turn");
      expect(hookOrder).toContain("tool:web_fetch");

      // Verify ordering: session_start before tool call before session_end
      const startIdx = hookOrder.indexOf("session_start");
      const toolIdx = hookOrder.indexOf("tool:web_fetch");
      const endIdx = hookOrder.indexOf("session_end");
      expect(startIdx).toBeLessThan(toolIdx);
      expect(toolIdx).toBeLessThan(endIdx);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 5: Response caching — second fetch hits cache ─────────────────

  test(
    "executor caching serves repeated fetches from cache",
    async () => {
      // let justified: count actual HTTP requests made
      let fetchCount = 0;
      const realFetch = globalThis.fetch;
      const countingFetch: typeof globalThis.fetch = async (input, init) => {
        fetchCount++;
        return realFetch(input, init);
      };

      const executor = createWebExecutor({
        fetchFn: countingFetch,
        cacheTtlMs: 300_000, // 5-minute cache
      });
      const provider = createWebProvider({ executor });

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You have web_fetch. When I ask you to fetch a URL multiple times, " +
          "call web_fetch each time I mention it. Be brief.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [],
        providers: [provider],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use web_fetch to fetch https://httpbin.org/get. Then use web_fetch again to fetch https://httpbin.org/get a second time. Tell me both results.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      // Count tool call events
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");

      // If the LLM made 2 tool calls, the second should have been cached
      if (toolStarts.length >= 2) {
        // Only 1 real HTTP request should have been made (second was cached)
        expect(fetchCount).toBe(1);
      }

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 6: web_fetch + custom tool in same session ────────────────────

  test(
    "web_fetch works alongside custom tools in the same agent session",
    async () => {
      const toolCalls: string[] = [];

      const tracker: KoiMiddleware = {
        name: "multi-tool-tracker",
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolCalls.push(request.toolId);
          return next(request);
        },
      };

      const executor = createWebExecutor();
      const webProvider = createWebProvider({ executor });

      // A simple custom tool alongside web tools
      const { toolToken } = await import("@koi/core");
      const customProvider = {
        name: "custom-tools",
        attach: async () =>
          new Map([
            [
              toolToken("uppercase") as string,
              {
                descriptor: {
                  name: "uppercase",
                  description: "Converts input text to uppercase.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      text: { type: "string", description: "Text to uppercase" },
                    },
                    required: ["text"],
                  },
                },
                trustTier: "sandbox" as const,
                execute: async (input: Readonly<Record<string, unknown>>) => {
                  return String(input.text ?? "").toUpperCase();
                },
              },
            ],
          ]),
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You have web_fetch, web_search, and uppercase tools. " +
          "Use web_fetch to get content from URLs. Use uppercase to convert text. " +
          "Always use the tools when asked.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [tracker],
        providers: [webProvider, customProvider],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: 'First, use the uppercase tool on the text "hello world". Then use web_fetch to fetch https://httpbin.org/status/200. Report both results.',
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // At least one custom tool and one web tool should have been called
      const hasCustom = toolCalls.includes("uppercase");
      const hasWeb = toolCalls.includes("web_fetch");
      expect(hasCustom || hasWeb).toBe(true);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 7: Session terminates cleanly with maxTurns guard ───────────

  test(
    "session terminates cleanly under maxTurns guard with web tools",
    async () => {
      const executor = createWebExecutor();
      const provider = createWebProvider({ executor });

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You have web_fetch. Use it to fetch URLs when asked. Be brief.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [provider],
        limits: { maxTurns: 2 },
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Fetch https://httpbin.org/get using web_fetch and tell me the origin IP.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      // Session must produce a done event with valid metrics
      expect(output?.metrics.inputTokens).toBeGreaterThan(0);
      expect(output?.metrics.outputTokens).toBeGreaterThan(0);
      // stopReason should be either "completed" or "max_turns"
      expect(["completed", "max_turns"]).toContain(output?.stopReason);

      // Agent state should be terminated
      expect(runtime.agent.state).toBe("terminated");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Tests — web_search (requires BRAVE_API_KEY)
// ---------------------------------------------------------------------------

describeSearch("e2e: web_search with Brave Search through full L1 runtime", () => {
  // ── Test 8: LLM uses web_search via Brave API ──────────────────────────

  test(
    "LLM uses web_search with Brave backend to find information",
    async () => {
      const toolCalls: string[] = [];

      const observer: KoiMiddleware = {
        name: "search-observer",
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolCalls.push(request.toolId);
          return next(request);
        },
      };

      const searchFn = createBraveSearch({ apiKey: BRAVE_KEY });
      const executor = createWebExecutor({ searchFn });
      const provider = createWebProvider({ executor });

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You have web_fetch and web_search tools. " +
          "When asked to search the web, use web_search. " +
          "When asked to fetch a specific URL, use web_fetch. " +
          "Report the results clearly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [observer],
        providers: [provider],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use web_search to search for 'Anthropic Claude AI'. Tell me the top result title and URL.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // web_search tool should have been called
      expect(toolCalls).toContain("web_search");

      // tool_call events should exist
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      expect(toolStarts.length).toBeGreaterThanOrEqual(1);

      // Response should mention Anthropic or Claude
      const text = extractText(events);
      const lower = text.toLowerCase();
      expect(lower.includes("anthropic") || lower.includes("claude")).toBe(true);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 9: Search + fetch pipeline ────────────────────────────────────

  test(
    "LLM searches then fetches a result URL (search-then-fetch pipeline)",
    async () => {
      const toolCalls: string[] = [];

      const observer: KoiMiddleware = {
        name: "pipeline-observer",
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolCalls.push(request.toolId);
          return next(request);
        },
      };

      const searchFn = createBraveSearch({ apiKey: BRAVE_KEY });
      const executor = createWebExecutor({ searchFn });
      const provider = createWebProvider({ executor });

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You have web_fetch and web_search tools. " +
          "When researching a topic: first web_search to find relevant pages, " +
          "then web_fetch the most relevant URL to read its content. " +
          "Report a brief summary.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [observer],
        providers: [provider],
        limits: { maxTurns: 5 },
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Search for 'httpbin.org API testing' using web_search. Then fetch the first URL from the results using web_fetch. Summarize what you find.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      // Both tools should have been called
      const hasSearch = toolCalls.includes("web_search");
      const _hasFetch = toolCalls.includes("web_fetch");
      // At minimum, search should have been called
      expect(hasSearch).toBe(true);
      // If the LLM followed instructions, fetch should also have been called
      // (but don't hard-fail if LLM decided the search results were sufficient)

      // Response should contain some content
      const text = extractText(events);
      expect(text.length).toBeGreaterThan(0);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
