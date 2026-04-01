/**
 * CI-safe end-to-end tests for @koi/tools-github through the full L1 runtime.
 *
 * Uses a scripted model call (queue of ModelResponse objects) so no API key
 * is needed — runs in every CI build.
 *
 * Validates:
 * 1. All 5 GitHub tools are discoverable through ECS assembly
 * 2. Scripted tool calls flow through the middleware chain
 * 3. Error paths (RATE_LIMIT, NOT_FOUND, PERMISSION) flow back to the model
 * 4. Multi-tool scripted sequences work end-to-end
 */

import { describe, expect, test } from "bun:test";
import type {
  EngineEvent,
  EngineOutput,
  JsonObject,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  ToolDescriptor,
  ToolHandler,
  ToolRequest,
  TurnContext,
} from "@koi/core";
import { toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import type { GhExecutor } from "../gh-executor.js";
import { createGithubProvider } from "../github-component-provider.js";
import { createMockGhExecutor, mockError, mockSuccess, mockSuccessRaw } from "../test-helpers.js";

// ---------------------------------------------------------------------------
// Scripted model helpers (same pattern as code-mode e2e-full-stack)
// ---------------------------------------------------------------------------

function createScriptedModelCall(
  script: readonly ModelResponse[],
): (request: ModelRequest) => Promise<ModelResponse> {
  /* let justified: mutable turn counter for scripted sequence */
  let callIndex = 0;
  return async (_request: ModelRequest): Promise<ModelResponse> => {
    const response = script[callIndex];
    if (response === undefined) {
      return { content: "Script exhausted", model: "scripted" };
    }
    callIndex++;
    return response;
  };
}

function toolCallResponse(toolName: string, input: JsonObject, callId?: string): ModelResponse {
  return {
    content: "",
    model: "scripted",
    metadata: {
      toolCalls: [
        {
          toolName,
          callId: callId ?? `call-${toolName}-${Date.now()}`,
          input,
        },
      ],
    },
  };
}

function textResponse(text: string): ModelResponse {
  return { content: text, model: "scripted" };
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

/** Parse the result from a tool_call_end event (may be stringified JSON or object). */
function parseToolResult(
  event: (EngineEvent & { readonly kind: "tool_call_end" }) | undefined,
): unknown {
  if (event === undefined) return undefined;
  return typeof event.result === "string" ? JSON.parse(event.result) : event.result;
}

// ---------------------------------------------------------------------------
// Mock runtime factory
// ---------------------------------------------------------------------------

async function createMockRuntime(
  executor: GhExecutor,
  script: readonly ModelResponse[],
  middleware?: readonly KoiMiddleware[],
): Promise<Awaited<ReturnType<typeof createKoi>>> {
  const provider = createGithubProvider({ executor });
  const modelCall = createScriptedModelCall(script);
  const adapter = createLoopAdapter({ modelCall, maxTurns: 10 });

  const runtime = await createKoi({
    manifest: { name: "gh-e2e-mock", version: "1.0.0", model: { name: "scripted" } },
    adapter,
    providers: [provider],
    middleware: middleware !== undefined ? [...middleware] : [],
    // Scripted model cannot loop — disable to avoid false positives
    loopDetection: false,
  });

  return runtime;
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
  statusCheckRollup: [{ name: "CI", status: "COMPLETED", conclusion: "SUCCESS" }],
  headRefName: "feat/awesome",
  baseRefName: "main",
  title: "Add awesome feature",
  additions: 42,
  deletions: 7,
  changedFiles: 3,
};

const CANNED_PR_CREATE = {
  number: 99,
  url: "https://github.com/test/repo/pull/99",
  headRefName: "feat/new-feature",
};

// ---------------------------------------------------------------------------
// Group 1: Assembly & Discovery
// ---------------------------------------------------------------------------

describe("e2e: CI-safe full-stack — tools-github through createKoi + createLoopAdapter", () => {
  test("all 5 GitHub tools are discoverable through ECS assembly", async () => {
    const executor = createMockGhExecutor([]);
    const runtime = await createMockRuntime(executor, [textResponse("OK")]);

    expect(runtime.agent.has(toolToken("github_pr_create"))).toBe(true);
    expect(runtime.agent.has(toolToken("github_pr_status"))).toBe(true);
    expect(runtime.agent.has(toolToken("github_pr_review"))).toBe(true);
    expect(runtime.agent.has(toolToken("github_pr_merge"))).toBe(true);
    expect(runtime.agent.has(toolToken("github_ci_wait"))).toBe(true);

    const tools = runtime.agent.query<{ readonly descriptor: ToolDescriptor }>("tool:");
    const names = [...tools.values()].map((t) => t.descriptor.name);
    expect(names).toContain("github_pr_status");
    expect(names).toContain("github_pr_create");
    expect(names).toContain("github_pr_review");
    expect(names).toContain("github_pr_merge");
    expect(names).toContain("github_ci_wait");

    await runtime.dispose();
  }, 30_000);

  test("scripted model calls github_pr_status and receives structured result", async () => {
    const executor = createMockGhExecutor([mockSuccess(CANNED_PR_STATUS)]);
    const runtime = await createMockRuntime(executor, [
      toolCallResponse("github_pr_status", { pr_number: 42 }),
      textResponse("Got the PR status"),
    ]);

    const events = await collectEvents(runtime.run({ kind: "text", text: "Check PR #42 status" }));

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("completed");

    const toolEnds = findToolCallEnds(events);
    expect(toolEnds.length).toBe(1);

    const result = parseToolResult(toolEnds[0]);
    expect(result).toHaveProperty("state", "OPEN");
    expect(result).toHaveProperty("title", "Add awesome feature");
    expect(result).toHaveProperty("reviewDecision", "APPROVED");

    expect(executor.calls.length).toBe(1);
    expect(executor.calls[0]?.args[0]).toBe("pr");
    expect(executor.calls[0]?.args[1]).toBe("view");

    await runtime.dispose();
  }, 30_000);

  test("scripted model calls github_pr_create and receives PR number", async () => {
    const executor = createMockGhExecutor([mockSuccess(CANNED_PR_CREATE)]);
    const runtime = await createMockRuntime(executor, [
      toolCallResponse("github_pr_create", {
        title: "Add login",
        body: "Implements OAuth",
      }),
      textResponse("PR created"),
    ]);

    const events = await collectEvents(runtime.run({ kind: "text", text: "Create a PR" }));

    const output = findDoneOutput(events);
    expect(output).toBeDefined();

    const toolEnds = findToolCallEnds(events);
    expect(toolEnds.length).toBe(1);

    const result = parseToolResult(toolEnds[0]);
    expect(result).toHaveProperty("number", 99);
    expect(result).toHaveProperty("url", expect.stringContaining("pull/99"));

    await runtime.dispose();
  }, 30_000);

  test("middleware wrapToolCall intercepts scripted GitHub tool calls", async () => {
    /* let justified: mutable spy array collecting tool IDs during wrapToolCall */
    const observedToolIds: string[] = [];

    const observerMiddleware: KoiMiddleware = {
      name: "tool-call-observer",
      describeCapabilities: () => undefined,
      wrapToolCall: async (_ctx: TurnContext, request: ToolRequest, next: ToolHandler) => {
        observedToolIds.push(request.toolId);
        return next(request);
      },
    };

    const executor = createMockGhExecutor([mockSuccess(CANNED_PR_STATUS)]);
    const runtime = await createMockRuntime(
      executor,
      [toolCallResponse("github_pr_status", { pr_number: 10 }), textResponse("Done")],
      [observerMiddleware],
    );

    const events = await collectEvents(runtime.run({ kind: "text", text: "Check PR" }));

    const output = findDoneOutput(events);
    expect(output).toBeDefined();

    expect(observedToolIds.length).toBeGreaterThanOrEqual(1);
    expect(observedToolIds).toContain("github_pr_status");

    await runtime.dispose();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Group 2: Error Paths
// ---------------------------------------------------------------------------

describe("e2e: error paths — tools-github through full pipeline", () => {
  test("RATE_LIMIT error flows through middleware chain as tool result", async () => {
    const executor = createMockGhExecutor([mockError("RATE_LIMIT", "API rate limit exceeded")]);
    const runtime = await createMockRuntime(executor, [
      toolCallResponse("github_pr_status", { pr_number: 42 }),
      textResponse("Got rate limit error"),
    ]);

    const events = await collectEvents(runtime.run({ kind: "text", text: "Check PR" }));

    const output = findDoneOutput(events);
    expect(output).toBeDefined();

    const toolEnds = findToolCallEnds(events);
    expect(toolEnds.length).toBe(1);

    const result = parseToolResult(toolEnds[0]);
    expect(result).toHaveProperty("code", "RATE_LIMIT");
    expect(result).toHaveProperty("error", expect.stringContaining("rate limit"));

    await runtime.dispose();
  }, 30_000);

  test("NOT_FOUND error flows through middleware chain as tool result", async () => {
    const executor = createMockGhExecutor([mockError("NOT_FOUND", "Pull request not found")]);
    const runtime = await createMockRuntime(executor, [
      toolCallResponse("github_pr_status", { pr_number: 9999 }),
      textResponse("PR not found"),
    ]);

    const events = await collectEvents(runtime.run({ kind: "text", text: "Check PR" }));

    const toolEnds = findToolCallEnds(events);
    expect(toolEnds.length).toBe(1);

    const result = parseToolResult(toolEnds[0]);
    expect(result).toHaveProperty("code", "NOT_FOUND");
    expect(result).toHaveProperty("error", expect.stringContaining("not found"));

    await runtime.dispose();
  }, 30_000);

  test("PERMISSION error flows through middleware chain as tool result", async () => {
    const executor = createMockGhExecutor([
      mockError("PERMISSION", "Resource not accessible by integration"),
    ]);
    const runtime = await createMockRuntime(executor, [
      toolCallResponse("github_pr_status", { pr_number: 42 }),
      textResponse("Permission denied"),
    ]);

    const events = await collectEvents(runtime.run({ kind: "text", text: "Check PR" }));

    const toolEnds = findToolCallEnds(events);
    expect(toolEnds.length).toBe(1);

    const result = parseToolResult(toolEnds[0]);
    expect(result).toHaveProperty("code", "PERMISSION");
    expect(result).toHaveProperty("error", expect.stringContaining("not accessible"));

    await runtime.dispose();
  }, 30_000);

  test("tool execution error is captured in tool_call_end event result", async () => {
    const executor = createMockGhExecutor([mockError("EXTERNAL", "gh CLI network timeout")]);
    const runtime = await createMockRuntime(executor, [
      toolCallResponse("github_pr_status", { pr_number: 1 }),
      textResponse("Error noted"),
    ]);

    const events = await collectEvents(runtime.run({ kind: "text", text: "Check PR" }));

    const toolEnds = findToolCallEnds(events);
    expect(toolEnds.length).toBe(1);

    const result = parseToolResult(toolEnds[0]);
    expect(result).toHaveProperty("code", "EXTERNAL");
    expect(result).toHaveProperty("error", expect.stringContaining("network timeout"));

    await runtime.dispose();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Group 3: Multi-tool Scripted Sequence
// ---------------------------------------------------------------------------

describe("e2e: multi-tool scripted sequence — tools-github", () => {
  test("scripted status → merge flows through full pipeline", async () => {
    // Provide all 3 executor calls: (1) status, (2) merge pre-validation, (3) merge
    const executor = createMockGhExecutor([
      mockSuccess(CANNED_PR_STATUS), // for github_pr_status
      mockSuccess(CANNED_PR_STATUS), // for github_pr_merge pre-validation (pr view)
      mockSuccessRaw("merged"), // for github_pr_merge actual merge
    ]);

    const runtime = await createMockRuntime(executor, [
      toolCallResponse("github_pr_status", { pr_number: 42 }),
      toolCallResponse("github_pr_merge", { pr_number: 42 }),
      textResponse("Status checked and PR merged"),
    ]);

    const events = await collectEvents(runtime.run({ kind: "text", text: "Check then merge" }));

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("completed");

    const toolEnds = findToolCallEnds(events);
    expect(toolEnds.length).toBe(2);

    const statusResult = parseToolResult(toolEnds[0]);
    expect(statusResult).toHaveProperty("state", "OPEN");

    const mergeResult = parseToolResult(toolEnds[1]);
    expect(mergeResult).toHaveProperty("merged", true);

    // Verify all 3 executor calls happened
    expect(executor.calls.length).toBe(3);
    expect(executor.calls[0]?.args.slice(0, 2)).toEqual(["pr", "view"]); // status
    expect(executor.calls[1]?.args.slice(0, 2)).toEqual(["pr", "view"]); // merge pre-validation
    expect(executor.calls[2]?.args.slice(0, 2)).toEqual(["pr", "merge"]); // actual merge

    await runtime.dispose();
  }, 30_000);
});
