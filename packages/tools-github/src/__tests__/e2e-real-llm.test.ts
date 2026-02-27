/**
 * E2E test — @koi/tools-github through the full Koi runtime.
 *
 * Proves that:
 *   1. Claude discovers all 5 GitHub tools from the agent entity
 *   2. Claude calls tools with correct arguments
 *   3. Tool results flow back through the middleware chain to the model
 *   4. The model uses tool results in its response
 *   5. Full lifecycle (session start → tool calls → session end) works
 *
 * Uses createMockGhExecutor so tools return canned responses instead of
 * calling the real `gh` CLI — but the LLM call, tool discovery, middleware
 * chain, and event pipeline are all real.
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1.
 *
 * Run: E2E_TESTS=1 bun --env-file=/Users/taofeng/koi/.env test e2e-real-llm
 */

import { describe, expect, test } from "bun:test";
import type {
  EngineEvent,
  EngineOutput,
  JsonObject,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  Tool,
  ToolDescriptor,
  ToolHandler,
  ToolRequest,
  TurnContext,
} from "@koi/core";
import { toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import type { GhExecuteOptions, GhExecutor } from "../gh-executor.js";
import { createGithubProvider } from "../github-component-provider.js";
import type { MockGhResponse } from "../test-helpers.js";
import { mockSuccess, mockSuccessRaw } from "../test-helpers.js";

// ---------------------------------------------------------------------------
// Gate on API key + E2E_TESTS env var
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const HAIKU_MODEL_ID = "claude-haiku-4-5-20251001" as const;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeReal = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Anthropic API types (tool calling)
// ---------------------------------------------------------------------------

interface AnthropicToolParam {
  readonly name: string;
  readonly description: string;
  readonly input_schema: JsonObject;
}

interface AnthropicTextBlock {
  readonly type: "text";
  readonly text: string;
}

interface AnthropicToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AnthropicToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string;
}

type AnthropicMessageContent =
  | string
  | readonly (AnthropicContentBlock | AnthropicToolResultBlock)[];

interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: AnthropicMessageContent;
}

interface AnthropicApiResponse {
  readonly id: string;
  readonly model: string;
  readonly content: readonly AnthropicContentBlock[];
  readonly stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

// ---------------------------------------------------------------------------
// Custom modelCall that bridges to Anthropic API WITH tool schemas
// ---------------------------------------------------------------------------

function createAnthropicModelCall(
  apiKey: string,
  toolDescriptors: readonly ToolDescriptor[],
): (request: ModelRequest) => Promise<ModelResponse> {
  const tools: readonly AnthropicToolParam[] = toolDescriptors.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

  return async (request: ModelRequest): Promise<ModelResponse> => {
    const messages = mapMessagesToAnthropic(request.messages);

    const body = {
      model: HAIKU_MODEL_ID,
      max_tokens: 4096,
      messages,
      tools,
    };

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Anthropic API ${response.status}: ${errorText}`);
    }

    const json = (await response.json()) as AnthropicApiResponse;
    return mapAnthropicToModelResponse(json);
  };
}

/**
 * Convert Koi InboundMessage[] to Anthropic message format.
 *
 * Handles three cases:
 * - User messages (senderId !== "assistant" and !== "tool")
 * - Assistant messages (may contain tool_use metadata)
 * - Tool result messages (senderId === "tool", has callId in metadata)
 */
function mapMessagesToAnthropic(
  messages: readonly {
    readonly content: readonly { readonly kind: string; readonly text?: string }[];
    readonly senderId?: string;
    readonly metadata?: JsonObject;
  }[],
): readonly AnthropicMessage[] {
  const result: AnthropicMessage[] = [];

  for (const msg of messages) {
    const text = msg.content
      .filter((b) => b.kind === "text" && typeof b.text === "string")
      .map((b) => b.text ?? "")
      .join("");

    if (msg.senderId === "tool") {
      const callId = (msg.metadata?.callId as string) ?? "";
      const toolResult: AnthropicToolResultBlock = {
        type: "tool_result",
        tool_use_id: callId,
        content: text,
      };

      const last = result[result.length - 1];
      if (last !== undefined && last.role === "user" && Array.isArray(last.content)) {
        result[result.length - 1] = {
          role: "user",
          content: [...(last.content as readonly AnthropicToolResultBlock[]), toolResult],
        };
      } else {
        result.push({ role: "user", content: [toolResult] });
      }
    } else if (msg.senderId === "assistant") {
      const toolCalls = msg.metadata?.toolCalls as
        | readonly {
            readonly toolName: string;
            readonly callId: string;
            readonly input: JsonObject;
          }[]
        | undefined;

      if (toolCalls !== undefined && toolCalls.length > 0) {
        const content: AnthropicContentBlock[] = [];
        if (text.length > 0) {
          content.push({ type: "text", text });
        }
        for (const tc of toolCalls) {
          content.push({
            type: "tool_use",
            id: tc.callId,
            name: tc.toolName,
            input: tc.input,
          });
        }
        result.push({ role: "assistant", content });
      } else {
        result.push({ role: "assistant", content: text });
      }
    } else {
      result.push({ role: "user", content: text });
    }
  }

  return result;
}

/**
 * Convert Anthropic API response to Koi ModelResponse.
 * Extracts tool_use blocks into metadata.toolCalls.
 */
function mapAnthropicToModelResponse(response: AnthropicApiResponse): ModelResponse {
  const textParts: string[] = [];
  const toolCalls: JsonObject[] = [];

  for (const block of response.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        toolName: block.name,
        callId: block.id,
        input: block.input,
      } satisfies JsonObject);
    }
  }

  const metadata: JsonObject | undefined = toolCalls.length > 0 ? { toolCalls } : undefined;

  return {
    content: textParts.join(""),
    model: response.model,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

// ---------------------------------------------------------------------------
// Routing mock executor — dispatches on gh subcommand
// ---------------------------------------------------------------------------

/**
 * Create a routing mock executor that returns canned responses based on
 * the `gh` subcommand pattern in args. This handles LLM non-determinism
 * (tools may be called in any order).
 */
function createRoutingMockExecutor(
  routes: ReadonlyMap<string, MockGhResponse>,
  fallback?: MockGhResponse,
): GhExecutor & {
  readonly calls: ReadonlyArray<{
    readonly args: readonly string[];
    readonly options: GhExecuteOptions | undefined;
  }>;
} {
  const calls: Array<{
    readonly args: readonly string[];
    readonly options: GhExecuteOptions | undefined;
  }> = [];

  return {
    calls,
    execute: async (args: readonly string[], options?: GhExecuteOptions) => {
      calls.push({ args, options });

      // Build a route key from the first 2-3 args (e.g. "pr view", "pr create", "pr merge")
      const key = args.slice(0, 2).join(" ");

      const route = routes.get(key);
      if (route !== undefined) {
        return route.result;
      }

      if (fallback !== undefined) {
        return fallback.result;
      }

      return {
        ok: false as const,
        error: {
          code: "EXTERNAL" as const,
          message: `Routing mock: no route for "${key}" (args: ${JSON.stringify(args)})`,
          retryable: false,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Event collection helpers
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

function findToolCallEnds(
  events: readonly EngineEvent[],
): readonly (EngineEvent & { readonly kind: "tool_call_end" })[] {
  return events.filter(
    (e): e is EngineEvent & { readonly kind: "tool_call_end" } => e.kind === "tool_call_end",
  );
}

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

// ---------------------------------------------------------------------------
// Two-phase assembly factory
// ---------------------------------------------------------------------------

/**
 * Build a runtime with a real Anthropic model call that includes tool schemas.
 *
 * Phase 1 (Discovery): Assemble a throwaway createKoi runtime with a noop
 *   model call to discover tool descriptors from the agent entity.
 * Phase 2 (Real): Create a real createAnthropicModelCall with those tool
 *   schemas, wire through createLoopAdapter, and run the full pipeline.
 */
async function createRealLLMRuntime(
  executor: GhExecutor,
  maxTurns: number,
  middleware?: readonly KoiMiddleware[],
): Promise<{
  readonly runtime: Awaited<ReturnType<typeof createKoi>>;
}> {
  const provider = createGithubProvider({ executor });

  // Phase 1: Assemble to discover tool descriptors
  const discoveryAdapter = createLoopAdapter({
    modelCall: async () => ({ content: "noop", model: "discovery" }),
    maxTurns: 1,
  });

  const discoveryRuntime = await createKoi({
    manifest: { name: "discovery", version: "0.0.0", model: { name: "discovery" } },
    adapter: discoveryAdapter,
    providers: [provider],
    loopDetection: false,
  });

  // Extract tool descriptors using the typed query accessor
  const toolDescriptors: ToolDescriptor[] = [];
  for (const tool of discoveryRuntime.agent.query<Tool>("tool:").values()) {
    toolDescriptors.push(tool.descriptor);
  }

  await discoveryRuntime.dispose();

  // Phase 2: Create real runtime with tool-aware model call
  const modelCall = createAnthropicModelCall(ANTHROPIC_KEY, toolDescriptors);
  const adapter = createLoopAdapter({ modelCall, maxTurns });

  // Re-create the provider since the executor is stateless across runtimes
  const realProvider = createGithubProvider({ executor });

  const runtime = await createKoi({
    manifest: { name: "github-e2e", version: "1.0.0", model: { name: "claude-haiku" } },
    adapter,
    providers: [realProvider],
    middleware: middleware !== undefined ? [...middleware] : [],
    loopDetection: false,
  });

  return { runtime };
}

// ---------------------------------------------------------------------------
// Canned response data
// ---------------------------------------------------------------------------

const CANNED_PR_STATUS = {
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  statusCheckRollup: [
    { name: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "Lint", status: "COMPLETED", conclusion: "SUCCESS" },
  ],
  headRefName: "feat/awesome",
  baseRefName: "main",
  title: "Add awesome feature",
  additions: 42,
  deletions: 7,
  changedFiles: 3,
};

const CANNED_PR_CREATE = {
  number: 123,
  url: "https://github.com/test/repo/pull/123",
  headRefName: "feat/new-feature",
};

const CANNED_PR_REVIEW_READ = {
  reviews: [{ author: { login: "reviewer1" }, state: "APPROVED", body: "LGTM!" }],
  latestReviews: [{ author: { login: "reviewer1" }, state: "APPROVED", body: "LGTM!" }],
  reviewDecision: "APPROVED",
};

const CANNED_DRAFT_PR_STATUS = {
  state: "OPEN",
  isDraft: true,
  mergeable: "MERGEABLE",
  mergeStateStatus: "BLOCKED",
  reviewDecision: "",
  statusCheckRollup: [],
  headRefName: "feat/wip",
  baseRefName: "main",
  title: "WIP: Draft feature",
  additions: 10,
  deletions: 0,
  changedFiles: 1,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeReal("e2e: real Anthropic LLM — @koi/tools-github through full Koi runtime", () => {
  // ── Test 1: Tool discovery ─────────────────────────────────────────────

  test("tool discovery: all 5 GitHub tools are registered on the agent", async () => {
    const executor = createRoutingMockExecutor(new Map());
    const { runtime } = await createRealLLMRuntime(executor, 1);

    expect(runtime.agent.has(toolToken("github_pr_create"))).toBe(true);
    expect(runtime.agent.has(toolToken("github_pr_status"))).toBe(true);
    expect(runtime.agent.has(toolToken("github_pr_review"))).toBe(true);
    expect(runtime.agent.has(toolToken("github_pr_merge"))).toBe(true);
    expect(runtime.agent.has(toolToken("github_ci_wait"))).toBe(true);

    await runtime.dispose();
  }, 30_000);

  // ── Test 2: LLM calls github_pr_status ─────────────────────────────────

  test("LLM calls github_pr_status to check a PR", async () => {
    const routes = new Map<string, MockGhResponse>([["pr view", mockSuccess(CANNED_PR_STATUS)]]);
    const executor = createRoutingMockExecutor(routes);
    const { runtime } = await createRealLLMRuntime(executor, 5);

    const events = await collectEvents(
      runtime.run({
        kind: "text",
        text: [
          "You have GitHub tools available.",
          "Use the github_pr_status tool to check the status of PR #42.",
          "Report the title, state, and review decision from the result.",
          "Do NOT explain your reasoning, just call the tool and report.",
        ].join("\n"),
      }),
    );

    const output = findDoneOutput(events);
    expect(output).toBeDefined();

    const toolEnds = findToolCallEnds(events);
    expect(toolEnds.length).toBeGreaterThanOrEqual(1);

    // Verify the executor was called with pr view args
    expect(executor.calls.length).toBeGreaterThanOrEqual(1);
    const prViewCall = executor.calls.find((c) => c.args[0] === "pr" && c.args[1] === "view");
    expect(prViewCall).toBeDefined();

    // Response should reference the canned data
    const text = extractText(events);
    const lower = text.toLowerCase();
    expect(
      lower.includes("awesome") ||
        lower.includes("open") ||
        lower.includes("approved") ||
        lower.includes("42"),
    ).toBe(true);

    await runtime.dispose();
  }, 120_000);

  // ── Test 3: LLM calls github_pr_create ─────────────────────────────────

  test("LLM calls github_pr_create to create a PR", async () => {
    const routes = new Map<string, MockGhResponse>([["pr create", mockSuccess(CANNED_PR_CREATE)]]);
    const executor = createRoutingMockExecutor(routes);
    const { runtime } = await createRealLLMRuntime(executor, 5);

    const events = await collectEvents(
      runtime.run({
        kind: "text",
        text: [
          "You have GitHub tools available.",
          'Use the github_pr_create tool to create a PR with title "Add login feature" and body "Implements OAuth login".',
          "Report the PR number and URL from the result.",
          "Do NOT explain your reasoning, just call the tool and report.",
        ].join("\n"),
      }),
    );

    const output = findDoneOutput(events);
    expect(output).toBeDefined();

    const toolEnds = findToolCallEnds(events);
    expect(toolEnds.length).toBeGreaterThanOrEqual(1);

    // Verify executor was called with pr create args
    const prCreateCall = executor.calls.find((c) => c.args[0] === "pr" && c.args[1] === "create");
    expect(prCreateCall).toBeDefined();

    // Response should reference the canned PR number or URL
    const text = extractText(events);
    expect(text.includes("123") || text.includes("pull/123")).toBe(true);

    await runtime.dispose();
  }, 120_000);

  // ── Test 4: LLM calls github_pr_review ─────────────────────────────────

  test("LLM calls github_pr_review to read reviews", async () => {
    const routes = new Map<string, MockGhResponse>([
      ["pr view", mockSuccess(CANNED_PR_REVIEW_READ)],
    ]);
    const executor = createRoutingMockExecutor(routes);
    const { runtime } = await createRealLLMRuntime(executor, 5);

    const events = await collectEvents(
      runtime.run({
        kind: "text",
        text: [
          "You have GitHub tools available.",
          'Use the github_pr_review tool with action="read" to read reviews on PR #42.',
          "Report the review decision and reviewer names.",
          "Do NOT explain your reasoning, just call the tool and report.",
        ].join("\n"),
      }),
    );

    const output = findDoneOutput(events);
    expect(output).toBeDefined();

    const toolEnds = findToolCallEnds(events);
    expect(toolEnds.length).toBeGreaterThanOrEqual(1);

    const text = extractText(events);
    const lower = text.toLowerCase();
    expect(
      lower.includes("approved") || lower.includes("reviewer1") || lower.includes("lgtm"),
    ).toBe(true);

    await runtime.dispose();
  }, 120_000);

  // ── Test 5: LLM calls github_pr_merge and gets pre-validation error ────

  test("LLM calls github_pr_merge and gets pre-validation error for draft PR", async () => {
    // pr_merge pre-validates by calling pr view first, which returns a draft PR
    const routes = new Map<string, MockGhResponse>([
      ["pr view", mockSuccess(CANNED_DRAFT_PR_STATUS)],
    ]);
    const executor = createRoutingMockExecutor(routes);
    const { runtime } = await createRealLLMRuntime(executor, 5);

    const events = await collectEvents(
      runtime.run({
        kind: "text",
        text: [
          "You have GitHub tools available.",
          "Use the github_pr_merge tool to merge PR #42.",
          "Report what happened — whether it succeeded or failed and why.",
          "Do NOT explain your reasoning, just call the tool and report.",
        ].join("\n"),
      }),
    );

    const output = findDoneOutput(events);
    expect(output).toBeDefined();

    const toolEnds = findToolCallEnds(events);
    expect(toolEnds.length).toBeGreaterThanOrEqual(1);

    // The tool should have returned an error about draft PR
    const text = extractText(events);
    const lower = text.toLowerCase();
    expect(
      lower.includes("draft") ||
        lower.includes("cannot") ||
        lower.includes("error") ||
        lower.includes("fail"),
    ).toBe(true);

    await runtime.dispose();
  }, 120_000);

  // ── Test 6: LLM calls github_ci_wait and gets immediate success ────────

  test("LLM calls github_ci_wait and gets immediate success for no checks", async () => {
    // A PR with no statusCheckRollup returns success immediately
    const prWithNoChecks = {
      statusCheckRollup: [],
    };
    const routes = new Map<string, MockGhResponse>([["pr view", mockSuccess(prWithNoChecks)]]);
    const executor = createRoutingMockExecutor(routes);
    const { runtime } = await createRealLLMRuntime(executor, 5);

    const events = await collectEvents(
      runtime.run({
        kind: "text",
        text: [
          "You have GitHub tools available.",
          "Use the github_ci_wait tool to wait for CI checks on PR #42.",
          "Report the final status.",
          "Do NOT explain your reasoning, just call the tool and report.",
        ].join("\n"),
      }),
    );

    const output = findDoneOutput(events);
    expect(output).toBeDefined();

    const toolEnds = findToolCallEnds(events);
    expect(toolEnds.length).toBeGreaterThanOrEqual(1);

    const text = extractText(events);
    const lower = text.toLowerCase();
    expect(
      lower.includes("success") ||
        lower.includes("pass") ||
        lower.includes("no checks") ||
        lower.includes("complete"),
    ).toBe(true);

    await runtime.dispose();
  }, 120_000);

  // ── Test 7: Middleware wrapToolCall fires ───────────────────────────────

  test("middleware wrapToolCall fires for GitHub tool calls", async () => {
    const observedToolIds: string[] = [];

    const observerMiddleware: KoiMiddleware = {
      name: "tool-call-observer",
      wrapToolCall: async (_ctx: TurnContext, request: ToolRequest, next: ToolHandler) => {
        observedToolIds.push(request.toolId);
        return next(request);
      },
    };

    const routes = new Map<string, MockGhResponse>([["pr view", mockSuccess(CANNED_PR_STATUS)]]);
    const executor = createRoutingMockExecutor(routes);
    const { runtime } = await createRealLLMRuntime(executor, 5, [observerMiddleware]);

    const events = await collectEvents(
      runtime.run({
        kind: "text",
        text: [
          "You have GitHub tools available.",
          "Use the github_pr_status tool to check PR #10.",
          "Report the result briefly. Do NOT explain, just call the tool.",
        ].join("\n"),
      }),
    );

    const output = findDoneOutput(events);
    expect(output).toBeDefined();

    // Middleware must have intercepted the tool call
    expect(observedToolIds.length).toBeGreaterThanOrEqual(1);
    expect(observedToolIds).toContain("github_pr_status");

    await runtime.dispose();
  }, 120_000);

  // ── Test 8: Multi-tool scenario ────────────────────────────────────────

  test("LLM checks status then decides based on tool result", async () => {
    const routes = new Map<string, MockGhResponse>([
      ["pr view", mockSuccess(CANNED_PR_STATUS)],
      ["pr merge", mockSuccessRaw("merged")],
    ]);
    const executor = createRoutingMockExecutor(routes);
    const { runtime } = await createRealLLMRuntime(executor, 8);

    const events = await collectEvents(
      runtime.run({
        kind: "text",
        text: [
          "You have GitHub tools: github_pr_status and github_pr_merge.",
          "First, use github_pr_status to check PR #42.",
          "Then use github_pr_merge to merge it.",
          "Report the final result. Do NOT explain your reasoning.",
        ].join("\n"),
      }),
    );

    const output = findDoneOutput(events);
    expect(output).toBeDefined();

    const toolEnds = findToolCallEnds(events);
    // Should have at least 2 tool calls (status + merge)
    expect(toolEnds.length).toBeGreaterThanOrEqual(2);

    // Verify both commands were called
    const statusCall = executor.calls.find((c) => c.args[0] === "pr" && c.args[1] === "view");
    const mergeCall = executor.calls.find((c) => c.args[0] === "pr" && c.args[1] === "merge");
    expect(statusCall).toBeDefined();
    expect(mergeCall).toBeDefined();

    await runtime.dispose();
  }, 120_000);
});
