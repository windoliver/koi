/**
 * End-to-end tests for @koi/eval with real LLM calls.
 *
 * Validates the full eval pipeline: run → grade → store → regress.
 *
 * Gated on ANTHROPIC_API_KEY — tests are skipped when the key is not set.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import type { EngineInput } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createExactMatchGrader } from "../graders/exact-match.js";
import { detectRegression } from "../regression.js";
import { createEvalRunner } from "../runner.js";
import type { AgentHandle, EvalRunConfig, EvalTask } from "../types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const describeE2E = HAS_KEY ? describe : describe.skip;

const TIMEOUT_MS = 60_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Agent factory
// ---------------------------------------------------------------------------

async function createAgent(): Promise<AgentHandle> {
  const piAdapter = createPiAdapter({
    model: E2E_MODEL,
    systemPrompt: "You are a concise test assistant. Reply briefly and exactly as instructed.",
    getApiKey: async () => ANTHROPIC_KEY,
  });

  const runtime = await createKoi({
    manifest: {
      name: "eval-e2e-agent",
      version: "1.0.0",
      model: { name: "claude-haiku" },
    },
    adapter: piAdapter,
    middleware: [],
    loopDetection: false,
    limits: { maxTurns: 3, maxDurationMs: 55_000, maxTokens: 5_000 },
  });

  return {
    stream: (input: EngineInput) => runtime.run(input),
    dispose: () => runtime.dispose(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: eval with real Anthropic API", () => {
  test(
    "runs a simple evaluation with exact match grader",
    async () => {
      const tasks: readonly EvalTask[] = [
        {
          id: "ping",
          name: "Ping-Pong",
          input: { kind: "text", text: "Reply with exactly one word: pong" },
          expected: { kind: "text", pattern: /pong/i },
          graders: [createExactMatchGrader()],
          timeoutMs: 30_000,
        },
        {
          id: "math",
          name: "Simple Math",
          input: { kind: "text", text: "What is 2 + 2? Reply with just the number." },
          expected: { kind: "text", pattern: "4" },
          graders: [createExactMatchGrader()],
          timeoutMs: 30_000,
        },
      ];

      const config: EvalRunConfig = {
        name: "e2e-test",
        tasks,
        agentFactory: createAgent,
        concurrency: 2,
        passThreshold: 0.5,
      };

      const runner = createEvalRunner(config);
      const run = await runner.run();

      console.log(`\n  Eval run: ${run.id}`);
      console.log(`  Pass rate: ${String(run.summary.passRate * 100)}%`);
      for (const trial of run.trials) {
        const icon = trial.status === "pass" ? "+" : trial.status === "fail" ? "x" : "!";
        console.log(`  [${icon}] ${trial.taskId} #${String(trial.trialIndex)}: ${trial.status}`);
      }

      expect(run.trials).toHaveLength(2);
      expect(run.summary.taskCount).toBe(2);
      // At least one trial should pass with a real LLM
      expect(run.summary.passRate).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  test(
    "regression detection works with real eval runs",
    async () => {
      const tasks: readonly EvalTask[] = [
        {
          id: "greet",
          name: "Greeting",
          input: { kind: "text", text: "Say hello in one word" },
          expected: { kind: "text", pattern: /hello/i },
          graders: [createExactMatchGrader()],
          trialCount: 2,
          timeoutMs: 30_000,
        },
      ];

      const config: EvalRunConfig = {
        name: "regression-test",
        tasks,
        agentFactory: createAgent,
        concurrency: 2,
      };

      const runner = createEvalRunner(config);
      const run = await runner.run();

      // Compare run against itself (no regression expected)
      const result = detectRegression(run.summary, run.summary);
      expect(result.kind).toBe("pass");
    },
    TIMEOUT_MS,
  );
});
