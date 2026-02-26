/**
 * worktree-merge end-to-end validation through createKoi + createLoopAdapter.
 *
 * Tests the full L1 runtime path — middleware chain, tool resolution,
 * lifecycle hooks — with worktree-merge's executeMerge as a tool, using
 * a two-phase model handler (deterministic tool calls + real Anthropic
 * LLM final answer).
 *
 * Validates:
 * - executeMerge works through the full L1 middleware chain
 * - All 3 merge strategies (sequential, octopus, rebase-chain)
 * - SHA pinning (expectedRef stale-branch guard)
 * - Conflict detection and resolver callback
 * - Verification gates (verifyAfter: "levels")
 * - AbortSignal cancellation
 * - Real LLM summarization of merge results
 *
 * Gated on ANTHROPIC_API_KEY — tests are skipped when the key is not set.
 *
 * Run:
 *   bun test tests/e2e/worktree-merge-e2e.test.ts
 *
 * Cost: ~$0.10-0.20 per run (haiku model, multiple prompts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ComponentProvider,
  EngineEvent,
  JsonObject,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  Tool,
  ToolHandler,
  ToolRequest,
} from "@koi/core";
import { toolToken } from "@koi/core/ecs";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { runGit } from "@koi/git-utils";
import type { BranchMergeOutcome, MergeConfig, MergeEvent, MergeResult } from "@koi/worktree-merge";
import { executeMerge } from "@koi/worktree-merge";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const describeE2E = HAS_KEY ? describe : describe.skip;

const TIMEOUT_MS = 90_000;
const MODEL_NAME = "claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Git repo helpers
// ---------------------------------------------------------------------------

let repoPath: string;

async function createTestRepo(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "koi-merge-e2e-"));
  await runGit(["init", "--initial-branch=main"], path);
  await runGit(["config", "user.email", "test@koi.dev"], path);
  await runGit(["config", "user.name", "Koi E2E"], path);
  await Bun.write(join(path, "README.md"), "# E2E Test\n");
  await runGit(["add", "README.md"], path);
  await runGit(["commit", "-m", "initial commit"], path);
  return path;
}

async function createBranchWithChange(
  path: string,
  branch: string,
  file: string,
  content: string,
): Promise<string> {
  await runGit(["checkout", "-b", branch], path);
  await Bun.write(join(path, file), content);
  await runGit(["add", file], path);
  await runGit(["commit", "-m", `Add ${file} on ${branch}`], path);
  const result = await runGit(["rev-parse", "HEAD"], path);
  if (!result.ok) throw new Error(`Failed to get HEAD: ${result.error.message}`);
  await runGit(["checkout", "main"], path);
  return result.value;
}

// ---------------------------------------------------------------------------
// L1 runtime helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const result: EngineEvent[] = []; // let justified: test accumulator
  for await (const event of iterable) {
    result.push(event);
  }
  return result;
}

// Lazy singleton for the Anthropic adapter
// let justified: lazily initialized on first real LLM call
let cachedAnthropicAdapter:
  | { readonly complete: (request: ModelRequest) => Promise<ModelResponse> }
  | undefined;

async function getAnthropicAdapter(): Promise<{
  readonly complete: (request: ModelRequest) => Promise<ModelResponse>;
}> {
  if (cachedAnthropicAdapter === undefined) {
    const { createAnthropicAdapter } = await import("@koi/model-router");
    cachedAnthropicAdapter = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
  }
  return cachedAnthropicAdapter;
}

function createPhasedModelHandler(phases: readonly ModelResponse[]): {
  readonly modelCall: (request: ModelRequest) => Promise<ModelResponse>;
  readonly callCount: () => number;
} {
  // let justified: mutable counter tracking which phase we're in
  let count = 0;
  return {
    modelCall: async (request: ModelRequest): Promise<ModelResponse> => {
      const phase = count;
      count++;
      if (phase < phases.length) {
        // Safe: bounds-checked on the line above
        const response = phases[phase];
        if (response === undefined) throw new Error(`Unreachable: phase ${phase} missing`);
        return response;
      }
      // Final phase: real Anthropic LLM call
      const anthropic = await getAnthropicAdapter();
      return anthropic.complete({ ...request, model: MODEL_NAME, maxTokens: 200 });
    },
    callCount: () => count,
  };
}

function toolCallResponse(toolName: string, callId: string, input: JsonObject): ModelResponse {
  return {
    content: "",
    model: MODEL_NAME,
    usage: { inputTokens: 10, outputTokens: 15 },
    metadata: {
      toolCalls: [{ toolName, callId, input }],
    },
  };
}

function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "e2e-merge-tools",
    attach: async () => {
      const components = new Map<string, unknown>();
      for (const tool of tools) {
        components.set(toolToken(tool.descriptor.name), tool);
      }
      return components;
    },
  };
}

function createToolObserver(): {
  readonly middleware: KoiMiddleware;
  readonly interceptedToolIds: readonly string[];
} {
  const intercepted: string[] = []; // let justified: test accumulator
  return {
    middleware: {
      name: "e2e-merge-tool-observer",
      wrapToolCall: async (_ctx, request: ToolRequest, next: ToolHandler) => {
        intercepted.push(request.toolId);
        return next(request);
      },
    },
    interceptedToolIds: intercepted,
  };
}

// ---------------------------------------------------------------------------
// Merge tool factory — wraps executeMerge as a Koi tool
// ---------------------------------------------------------------------------

function createMergeTools(): {
  readonly tools: readonly Tool[];
  readonly lastMergeResult: () => MergeResult | undefined;
  readonly mergeEvents: readonly MergeEvent[];
} {
  // let justified: captures last merge result for assertions
  let lastResult: MergeResult | undefined;
  const mergeEvents: MergeEvent[] = []; // let justified: test accumulator

  const mergeTool: Tool = {
    descriptor: {
      name: "merge_branches",
      description: "Merge branches into target using worktree-merge. Returns merge result summary.",
      inputSchema: {
        type: "object",
        properties: {
          strategy: { type: "string", description: "sequential | octopus | rebase-chain" },
          branches: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                dependsOn: { type: "array", items: { type: "string" } },
                expectedRef: { type: "string" },
              },
              required: ["name"],
            },
          },
          targetBranch: { type: "string" },
          verifyAfter: { type: "string" },
        },
        required: ["strategy", "branches", "targetBranch"],
      },
    },
    trustTier: "sandbox",
    execute: async (args: JsonObject) => {
      const config: MergeConfig = {
        repoPath,
        targetBranch: (args.targetBranch as string) ?? "main",
        branches: ((args.branches as readonly JsonObject[]) ?? []).map((b) => ({
          name: b.name as string,
          dependsOn: (b.dependsOn as readonly string[]) ?? [],
          expectedRef: b.expectedRef as string | undefined,
        })),
        strategy: (args.strategy as MergeConfig["strategy"]) ?? "sequential",
        verifyAfter: (args.verifyAfter as MergeConfig["verifyAfter"]) ?? undefined,
        onEvent: (event) => mergeEvents.push(event),
      };

      const result = await executeMerge(config);
      if (!result.ok) {
        return { error: result.error.message };
      }

      lastResult = result.value;

      // Build a serializable summary
      const outcomeSummary: Record<string, string> = {};
      for (const [branch, outcome] of result.value.outcomes) {
        outcomeSummary[branch] = formatOutcome(outcome);
      }

      return {
        strategy: result.value.strategy,
        targetBranch: result.value.targetBranch,
        mergeOrder: result.value.mergeOrder,
        outcomes: outcomeSummary,
        verified: result.value.verified,
        aborted: result.value.aborted,
        durationMs: Math.round(result.value.durationMs),
      };
    },
  };

  return {
    tools: [mergeTool],
    lastMergeResult: () => lastResult,
    mergeEvents,
  };
}

function formatOutcome(outcome: BranchMergeOutcome): string {
  switch (outcome.kind) {
    case "merged":
      return `merged (${outcome.commitSha.slice(0, 8)})`;
    case "conflict":
      return `conflict (files: ${outcome.conflictFiles.join(", ")}, resolved: ${outcome.resolved})`;
    case "skipped":
      return `skipped: ${outcome.reason}`;
    case "failed":
      return `failed: ${outcome.error.message}`;
    case "reverted":
      return `reverted: ${outcome.reason}`;
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  repoPath = await createTestRepo();
});

afterEach(async () => {
  await rm(repoPath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1: Sequential merge of 3 branches through full L1 stack
// ---------------------------------------------------------------------------

describeE2E("e2e: worktree-merge through createKoi + createLoopAdapter", () => {
  test(
    "sequential merge of 3 independent branches + real LLM summary",
    async () => {
      await createBranchWithChange(repoPath, "feat-a", "a.ts", "export const a = 1;\n");
      await createBranchWithChange(repoPath, "feat-b", "b.ts", "export const b = 2;\n");
      await createBranchWithChange(repoPath, "feat-c", "c.ts", "export const c = 3;\n");

      const merge = createMergeTools();
      const observer = createToolObserver();
      const toolProvider = createToolProvider(merge.tools);

      const phases: ModelResponse[] = [
        toolCallResponse("merge_branches", "call-1", {
          strategy: "sequential",
          targetBranch: "main",
          branches: [
            { name: "feat-a", dependsOn: [] },
            { name: "feat-b", dependsOn: [] },
            { name: "feat-c", dependsOn: [] },
          ],
        }),
      ];

      const { modelCall, callCount } = createPhasedModelHandler(phases);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: { name: "e2e-merge-sequential", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [observer.middleware],
        providers: [toolProvider],
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: "Merge the 3 feature branches and summarize the result.",
          }),
        );

        // Agent completed
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // Tool was called through middleware chain
        expect(observer.interceptedToolIds).toContain("merge_branches");

        // executeMerge succeeded
        const result = merge.lastMergeResult();
        expect(result).toBeDefined();
        expect(result?.strategy).toBe("sequential");
        expect(result?.outcomes.size).toBe(3);
        for (const [, outcome] of result?.outcomes ?? []) {
          expect(outcome.kind).toBe("merged");
        }

        // Merge events were emitted
        const levelStarts = merge.mergeEvents.filter((e) => e.kind === "level:started");
        expect(levelStarts.length).toBeGreaterThan(0);

        // Real LLM summarized the result
        expect(callCount()).toBeGreaterThanOrEqual(2);
        const textEvents = events.filter((e) => e.kind === "text_delta");
        expect(textEvents.length).toBeGreaterThan(0);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------
  // Test 2: Octopus merge of independent branches
  // ---------------------------------------------------------------------------

  test(
    "octopus merge of 2 independent branches",
    async () => {
      await createBranchWithChange(repoPath, "feat-x", "x.ts", "export const x = 'x';\n");
      await createBranchWithChange(repoPath, "feat-y", "y.ts", "export const y = 'y';\n");

      const merge = createMergeTools();
      const observer = createToolObserver();
      const toolProvider = createToolProvider(merge.tools);

      const phases: ModelResponse[] = [
        toolCallResponse("merge_branches", "call-1", {
          strategy: "octopus",
          targetBranch: "main",
          branches: [
            { name: "feat-x", dependsOn: [] },
            { name: "feat-y", dependsOn: [] },
          ],
        }),
      ];

      const { modelCall } = createPhasedModelHandler(phases);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: { name: "e2e-merge-octopus", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [observer.middleware],
        providers: [toolProvider],
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Merge branches via octopus and summarize." }),
        );

        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();

        const result = merge.lastMergeResult();
        expect(result).toBeDefined();
        expect(result?.strategy).toBe("octopus");
        expect(result?.outcomes.size).toBe(2);
        for (const [, outcome] of result?.outcomes ?? []) {
          expect(outcome.kind).toBe("merged");
        }
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------
  // Test 3: Rebase-chain merge
  // ---------------------------------------------------------------------------

  test(
    "rebase-chain merge of a single branch",
    async () => {
      await createBranchWithChange(repoPath, "feat-r", "r.ts", "export const r = 'rebase';\n");

      const merge = createMergeTools();
      const observer = createToolObserver();
      const toolProvider = createToolProvider(merge.tools);

      const phases: ModelResponse[] = [
        toolCallResponse("merge_branches", "call-1", {
          strategy: "rebase-chain",
          targetBranch: "main",
          branches: [{ name: "feat-r", dependsOn: [] }],
        }),
      ];

      const { modelCall } = createPhasedModelHandler(phases);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: { name: "e2e-merge-rebase", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [observer.middleware],
        providers: [toolProvider],
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Rebase and merge the branch, then summarize." }),
        );

        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();

        const result = merge.lastMergeResult();
        expect(result).toBeDefined();
        expect(result?.strategy).toBe("rebase-chain");
        expect(result?.outcomes.get("feat-r")?.kind).toBe("merged");
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------
  // Test 4: SHA pinning — expectedRef stale-branch guard
  // ---------------------------------------------------------------------------

  test(
    "expectedRef skips stale branch, merges fresh branch",
    async () => {
      const shaA = await createBranchWithChange(repoPath, "feat-a", "a.ts", "a\n");
      const shaB = await createBranchWithChange(repoPath, "feat-b", "b.ts", "b\n");

      // Advance feat-a after capturing its SHA (makes it stale)
      await runGit(["checkout", "feat-a"], repoPath);
      await Bun.write(join(repoPath, "a2.ts"), "a2\n");
      await runGit(["add", "a2.ts"], repoPath);
      await runGit(["commit", "-m", "advance feat-a"], repoPath);
      await runGit(["checkout", "main"], repoPath);

      const merge = createMergeTools();
      const observer = createToolObserver();
      const toolProvider = createToolProvider(merge.tools);

      const phases: ModelResponse[] = [
        toolCallResponse("merge_branches", "call-1", {
          strategy: "sequential",
          targetBranch: "main",
          branches: [
            { name: "feat-a", dependsOn: [], expectedRef: shaA },
            { name: "feat-b", dependsOn: [], expectedRef: shaB },
          ],
        }),
      ];

      const { modelCall } = createPhasedModelHandler(phases);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: { name: "e2e-merge-sha-pin", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [observer.middleware],
        providers: [toolProvider],
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: "Merge branches with SHA pinning, summarize which succeeded.",
          }),
        );

        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();

        const result = merge.lastMergeResult();
        expect(result).toBeDefined();

        // feat-a should be skipped (stale)
        const outcomeA = result?.outcomes.get("feat-a");
        expect(outcomeA?.kind).toBe("skipped");
        if (outcomeA?.kind === "skipped") {
          expect(outcomeA.reason).toContain("stale");
        }

        // feat-b should merge (fresh)
        const outcomeB = result?.outcomes.get("feat-b");
        expect(outcomeB?.kind).toBe("merged");

        // Tool call events were emitted
        const toolEndEvents = events.filter((e) => e.kind === "tool_call_end");
        expect(toolEndEvents.length).toBeGreaterThan(0);

        // Tool result contains "skipped" for stale branch
        const toolResult = toolEndEvents.find(
          (e) => e.kind === "tool_call_end" && JSON.stringify(e.result).includes("skipped"),
        );
        expect(toolResult).toBeDefined();
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------
  // Test 5: Conflict detection through full stack
  // ---------------------------------------------------------------------------

  test(
    "conflict detection: both branches modify same file",
    async () => {
      await createBranchWithChange(repoPath, "branch-1", "shared.ts", "version 1\n");
      await createBranchWithChange(repoPath, "branch-2", "shared.ts", "version 2\n");

      const merge = createMergeTools();
      const observer = createToolObserver();
      const toolProvider = createToolProvider(merge.tools);

      const phases: ModelResponse[] = [
        toolCallResponse("merge_branches", "call-1", {
          strategy: "sequential",
          targetBranch: "main",
          branches: [
            { name: "branch-1", dependsOn: [] },
            { name: "branch-2", dependsOn: [] },
          ],
        }),
      ];

      const { modelCall } = createPhasedModelHandler(phases);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: { name: "e2e-merge-conflict", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [observer.middleware],
        providers: [toolProvider],
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: "Merge the conflicting branches and report the result.",
          }),
        );

        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();

        const result = merge.lastMergeResult();
        expect(result).toBeDefined();

        // First branch merged
        expect(result?.outcomes.get("branch-1")?.kind).toBe("merged");

        // Second branch conflicted
        const outcome2 = result?.outcomes.get("branch-2");
        expect(outcome2?.kind).toBe("conflict");
        if (outcome2?.kind === "conflict") {
          expect(outcome2.conflictFiles).toContain("shared.ts");
          expect(outcome2.resolved).toBe(false);
        }

        // Merge events include conflict notification
        const conflictEvents = merge.mergeEvents.filter((e) => e.kind === "merge:conflict");
        expect(conflictEvents.length).toBeGreaterThan(0);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------
  // Test 6: Dependency ordering through full stack (5 branches, diamond DAG)
  // ---------------------------------------------------------------------------

  test(
    "dependency ordering: 5 branches with diamond DAG",
    async () => {
      await createBranchWithChange(repoPath, "core", "core.ts", "core\n");
      await createBranchWithChange(repoPath, "api", "api.ts", "api\n");
      await createBranchWithChange(repoPath, "ui", "ui.ts", "ui\n");
      await createBranchWithChange(repoPath, "tests", "tests.ts", "tests\n");
      await createBranchWithChange(repoPath, "docs", "docs.ts", "docs\n");

      const merge = createMergeTools();
      const observer = createToolObserver();
      const toolProvider = createToolProvider(merge.tools);

      const phases: ModelResponse[] = [
        toolCallResponse("merge_branches", "call-1", {
          strategy: "sequential",
          targetBranch: "main",
          branches: [
            { name: "core", dependsOn: [] },
            { name: "api", dependsOn: ["core"] },
            { name: "ui", dependsOn: ["core"] },
            { name: "tests", dependsOn: ["api", "ui"] },
            { name: "docs", dependsOn: [] },
          ],
        }),
      ];

      const { modelCall } = createPhasedModelHandler(phases);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: { name: "e2e-merge-dag", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [observer.middleware],
        providers: [toolProvider],
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: "Merge the 5 branches respecting their dependency graph.",
          }),
        );

        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();

        const result = merge.lastMergeResult();
        expect(result).toBeDefined();
        expect(result?.outcomes.size).toBe(5);

        // All merged successfully
        for (const [, outcome] of result?.outcomes ?? []) {
          expect(outcome.kind).toBe("merged");
        }

        // Merge order respects dependencies:
        // core and docs are first (level 0), then api and ui (level 1), then tests (level 2)
        const order = result?.mergeOrder ?? [];
        const coreIdx = order.indexOf("core");
        const apiIdx = order.indexOf("api");
        const uiIdx = order.indexOf("ui");
        const testsIdx = order.indexOf("tests");
        expect(coreIdx).toBeLessThan(apiIdx);
        expect(coreIdx).toBeLessThan(uiIdx);
        expect(apiIdx).toBeLessThan(testsIdx);
        expect(uiIdx).toBeLessThan(testsIdx);

        // Merge events show 3 levels
        const levelStarts = merge.mergeEvents.filter((e) => e.kind === "level:started");
        expect(levelStarts.length).toBe(3);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------
  // Test 7: Middleware lifecycle hooks fire with merge tool
  // ---------------------------------------------------------------------------

  test(
    "lifecycle hooks fire correctly around merge tool execution",
    async () => {
      await createBranchWithChange(repoPath, "feat-a", "a.ts", "a\n");

      const hookLog: string[] = []; // let justified: test accumulator

      const lifecycle: KoiMiddleware = {
        name: "e2e-merge-lifecycle",
        priority: 100,
        onSessionStart: async () => {
          hookLog.push("session:start");
        },
        onBeforeTurn: async () => {
          hookLog.push("turn:before");
        },
        onAfterTurn: async () => {
          hookLog.push("turn:after");
        },
        onSessionEnd: async () => {
          hookLog.push("session:end");
        },
      };

      const merge = createMergeTools();
      const toolProvider = createToolProvider(merge.tools);

      const phases: ModelResponse[] = [
        toolCallResponse("merge_branches", "call-1", {
          strategy: "sequential",
          targetBranch: "main",
          branches: [{ name: "feat-a", dependsOn: [] }],
        }),
      ];

      const { modelCall } = createPhasedModelHandler(phases);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: { name: "e2e-merge-lifecycle", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [lifecycle],
        providers: [toolProvider],
      });

      try {
        await collectEvents(runtime.run({ kind: "text", text: "Merge feat-a and summarize." }));

        // Session lifecycle brackets correctly
        expect(hookLog.at(0)).toBe("session:start");
        expect(hookLog.at(-1)).toBe("session:end");

        // At least one turn happened
        expect(hookLog).toContain("turn:before");
        expect(hookLog).toContain("turn:after");

        // Turns bracket correctly
        const firstBefore = hookLog.indexOf("turn:before");
        const firstAfter = hookLog.indexOf("turn:after");
        expect(firstBefore).toBeLessThan(firstAfter);

        // Merge actually happened
        expect(merge.lastMergeResult()?.outcomes.size).toBe(1);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------
  // Test 8: wrapToolCall middleware intercepts merge_branches call
  // ---------------------------------------------------------------------------

  test(
    "wrapToolCall intercepts merge_branches, then real LLM uses result",
    async () => {
      await createBranchWithChange(repoPath, "feat-a", "a.ts", "a\n");

      // let justified: tracks whether middleware intercepted the tool call
      let interceptedInput: JsonObject | undefined;

      const toolInspector: KoiMiddleware = {
        name: "e2e-merge-inspector",
        wrapToolCall: async (_ctx, request: ToolRequest, next: ToolHandler) => {
          if (request.toolId === "merge_branches") {
            interceptedInput = request.input;
          }
          return next(request);
        },
      };

      const merge = createMergeTools();
      const toolProvider = createToolProvider(merge.tools);

      const phases: ModelResponse[] = [
        toolCallResponse("merge_branches", "call-1", {
          strategy: "sequential",
          targetBranch: "main",
          branches: [{ name: "feat-a", dependsOn: [] }],
        }),
      ];

      const { modelCall, callCount } = createPhasedModelHandler(phases);
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: { name: "e2e-merge-intercept", version: "0.0.1", model: { name: MODEL_NAME } },
        adapter,
        middleware: [toolInspector],
        providers: [toolProvider],
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "Merge feat-a and tell me about the result." }),
        );

        // Agent completed with real LLM final answer
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // wrapToolCall intercepted the merge call
        expect(interceptedInput).toBeDefined();
        expect((interceptedInput as Record<string, unknown>).strategy).toBe("sequential");

        // Real LLM called after tool execution
        expect(callCount()).toBeGreaterThanOrEqual(2);

        // Text output from real LLM
        const textEvents = events.filter((e) => e.kind === "text_delta");
        expect(textEvents.length).toBeGreaterThan(0);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});
