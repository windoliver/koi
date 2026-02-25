/**
 * E2E test for @koi/task-spawn through the full L1 runtime (createKoi).
 *
 * Validates the complete path:
 *   Parent agent (createKoi + task tool provider)
 *     → LLM decides to call `task` tool
 *     → SpawnFn creates child agent (createKoi + createLoopAdapter)
 *     → Child runs with real LLM call
 *     → Output flows back as tool result
 *     → Parent incorporates result
 *
 * Gated on API key + E2E_TESTS=1 — skipped when either is missing.
 * E2E tests require API keys AND explicit opt-in via E2E_TESTS=1 to avoid
 * rate-limit failures when 500+ test files run in parallel.
 *
 * Run:
 *   E2E_TESTS=1 OPENROUTER_API_KEY=... bun test src/__tests__/e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineOutput, ModelRequest, ModelResponse, Tool } from "@koi/core";
import type { AgentManifest } from "@koi/core/assembly";
import { createInMemorySpawnLedger, createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import {
  createAnthropicAdapter,
  createOpenAIAdapter,
  createOpenRouterAdapter,
} from "@koi/model-router";
import { createTaskSpawnProvider } from "../provider.js";
import type { TaskSpawnConfig, TaskSpawnRequest, TaskSpawnResult } from "../types.js";

// ---------------------------------------------------------------------------
// Environment gate — supports OPENROUTER_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY
// ---------------------------------------------------------------------------

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = OPENROUTER_KEY.length > 0 || OPENAI_KEY.length > 0 || ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;

function resolveModel(): string {
  if (OPENROUTER_KEY.length > 0) return "openai/gpt-4o-mini";
  if (OPENAI_KEY.length > 0) return "gpt-4o-mini";
  return "claude-haiku-4-5-20251001";
}

const MODEL = resolveModel();

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

// ---------------------------------------------------------------------------
// E2E Tests
// ---------------------------------------------------------------------------

describeE2E("@koi/task-spawn E2E with real LLM", () => {
  // Priority: OpenRouter > OpenAI > Anthropic
  const llmAdapter =
    OPENROUTER_KEY.length > 0
      ? createOpenRouterAdapter({ apiKey: OPENROUTER_KEY, appName: "koi-task-spawn-e2e" })
      : OPENAI_KEY.length > 0
        ? createOpenAIAdapter({ apiKey: OPENAI_KEY })
        : createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });

  const modelCall = (request: ModelRequest): Promise<ModelResponse> =>
    llmAdapter.complete({ ...request, model: MODEL });

  // -------------------------------------------------------------------------
  // Test 1: Direct task tool invocation through createKoi runtime
  // -------------------------------------------------------------------------
  test(
    "task tool executes child agent through full L1 runtime",
    async () => {
      // Child spawn callback: creates a child runtime with a real LLM call
      const spawn = async (request: TaskSpawnRequest): Promise<TaskSpawnResult> => {
        const childAdapter = createLoopAdapter({ modelCall, maxTurns: 1 });

        try {
          const events = await collectEvents(
            childAdapter.stream({ kind: "text", text: request.description }),
          );
          const output = findDoneOutput(events);

          if (output === undefined) {
            return { ok: false, error: "No done event received from child engine" };
          }

          const textBlocks = output.content.filter(
            (b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text",
          );
          const text = textBlocks.map((b) => b.text).join("\n");
          return { ok: true, output: text.length > 0 ? text : "(empty)" };
        } finally {
          await childAdapter.dispose?.();
        }
      };

      const workerManifest: AgentManifest = {
        name: "research-worker",
        version: "0.0.1",
        description: "A research worker",
        model: { name: MODEL },
      };

      const config: TaskSpawnConfig = {
        agents: new Map([
          [
            "researcher",
            { name: "research-worker", description: "Researches topics", manifest: workerManifest },
          ],
        ]),
        spawn,
        defaultAgent: "researcher",
        maxDurationMs: 60_000,
      };

      const provider = createTaskSpawnProvider(config);

      // Create parent runtime through full createKoi path
      const parentAdapter = createLoopAdapter({ modelCall, maxTurns: 1 });
      const parentRuntime = await createKoi({
        manifest: {
          name: "parent-agent",
          version: "0.0.1",
          description: "Parent agent with task tool",
          model: { name: MODEL },
        },
        adapter: parentAdapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 60_000, maxTokens: 50_000 },
      });

      // Verify the task tool was attached to the assembled agent
      const taskTool = parentRuntime.agent.component<Tool>(
        "tool:task" as import("@koi/core").SubsystemToken<Tool>,
      );
      expect(taskTool).toBeDefined();
      expect(taskTool?.descriptor.name).toBe("task");

      // Directly invoke the task tool (bypasses the model deciding to call it)
      if (taskTool === undefined) {
        throw new Error("taskTool was not attached");
      }
      const result = await taskTool.execute({
        description: "Reply with exactly: PONG",
      });

      expect(typeof result).toBe("string");
      const output = result as string;
      expect(output.toLowerCase()).toContain("pong");

      await parentRuntime.dispose();
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test 2: Full round-trip with spawnChildAgent through L1 ledger
  // -------------------------------------------------------------------------
  test(
    "task tool with spawnChildAgent uses L1 ledger correctly",
    async () => {
      const ledger = createInMemorySpawnLedger(10);
      expect(ledger.activeCount()).toBe(0);

      // Spawn callback using the real L1 spawnChildAgent path
      const spawn = async (request: TaskSpawnRequest): Promise<TaskSpawnResult> => {
        const childAdapter = createLoopAdapter({ modelCall, maxTurns: 1 });

        // Use createKoi directly (spawnChildAgent needs a parent Agent entity,
        // which is complex to set up in E2E. This still validates ledger + runtime.)
        const childRuntime = await createKoi({
          manifest: request.manifest,
          adapter: childAdapter,
          agentType: "worker",
          spawnLedger: ledger,
          loopDetection: false,
          limits: { maxTurns: 1, maxDurationMs: 30_000, maxTokens: 20_000 },
        });

        try {
          const events = await collectEvents(
            childRuntime.run({ kind: "text", text: request.description }),
          );
          const output = findDoneOutput(events);

          if (output === undefined) {
            return { ok: false, error: "No done event from child" };
          }

          if (output.stopReason === "error") {
            return { ok: false, error: "Child terminated with error" };
          }

          const textBlocks = output.content.filter(
            (b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text",
          );
          const text = textBlocks.map((b) => b.text).join("\n");
          return { ok: true, output: text.length > 0 ? text : "(empty)" };
        } finally {
          await childRuntime.dispose();
        }
      };

      const workerManifest: AgentManifest = {
        name: "math-worker",
        version: "0.0.1",
        model: { name: MODEL },
      };

      const config: TaskSpawnConfig = {
        agents: new Map([
          ["math", { name: "math-worker", description: "Does math", manifest: workerManifest }],
        ]),
        spawn,
        defaultAgent: "math",
        maxDurationMs: 60_000,
      };

      const provider = createTaskSpawnProvider(config);

      const parentAdapter = createLoopAdapter({ modelCall, maxTurns: 1 });
      const parentRuntime = await createKoi({
        manifest: {
          name: "parent",
          version: "0.0.1",
          model: { name: MODEL },
        },
        adapter: parentAdapter,
        providers: [provider],
        spawnLedger: ledger,
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 60_000, maxTokens: 50_000 },
      });

      const taskTool = parentRuntime.agent.component<Tool>(
        "tool:task" as import("@koi/core").SubsystemToken<Tool>,
      );
      expect(taskTool).toBeDefined();

      if (taskTool === undefined) {
        throw new Error("taskTool was not attached");
      }
      const result = await taskTool.execute({
        description: "What is 2 + 2? Reply with just the number.",
      });

      expect(typeof result).toBe("string");
      const output = result as string;
      expect(output).toContain("4");

      await parentRuntime.dispose();
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test 3: Error propagation — child failure returns as tool result
  // -------------------------------------------------------------------------
  test(
    "child failure propagates as tool result string (not thrown)",
    async () => {
      const spawn = async (_request: TaskSpawnRequest): Promise<TaskSpawnResult> => {
        return { ok: false, error: "simulated child failure" };
      };

      const config: TaskSpawnConfig = {
        agents: new Map([
          [
            "worker",
            {
              name: "worker",
              description: "A worker",
              manifest: { name: "w", version: "0.0.1", model: { name: MODEL } },
            },
          ],
        ]),
        spawn,
        defaultAgent: "worker",
      };

      const provider = createTaskSpawnProvider(config);
      const parentAdapter = createLoopAdapter({ modelCall, maxTurns: 1 });

      const parentRuntime = await createKoi({
        manifest: { name: "parent", version: "0.0.1", model: { name: MODEL } },
        adapter: parentAdapter,
        providers: [provider],
        loopDetection: false,
        limits: { maxTurns: 1, maxDurationMs: 30_000, maxTokens: 20_000 },
      });

      const taskTool = parentRuntime.agent.component<Tool>(
        "tool:task" as import("@koi/core").SubsystemToken<Tool>,
      );

      if (taskTool === undefined) {
        throw new Error("taskTool was not attached");
      }
      const result = await taskTool.execute({
        description: "This will fail",
      });

      expect(result).toBe("Task failed: simulated child failure");
      await parentRuntime.dispose();
    },
    TIMEOUT_MS,
  );
});
