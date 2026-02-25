#!/usr/bin/env bun
/**
 * Basic eval suite + CI runner for @koi/eval.
 *
 * Demonstrates the full pipeline: agent factory → tasks → run → store → regress → report.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... bun run packages/eval/examples/basic-eval.ts
 *   EVAL_STORE_DIR=./my-results bun run packages/eval/examples/basic-eval.ts
 */

import type { EngineInput } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createExactMatchGrader } from "../src/graders/exact-match.js";
import { createJsonSchemaGrader } from "../src/graders/json-schema.js";
import { detectRegression } from "../src/regression.js";
import { formatCiReport } from "../src/reporter.js";
import { createEvalRunner } from "../src/runner.js";
import { createFsEvalStore } from "../src/store/fs-store.js";
import type { AgentHandle, EvalTask } from "../src/types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
if (ANTHROPIC_KEY.length === 0) {
  console.error("ANTHROPIC_API_KEY is not set. Set it to run evals:");
  console.error("  ANTHROPIC_API_KEY=sk-ant-... bun run packages/eval/examples/basic-eval.ts");
  process.exit(1);
}

const EVAL_MODEL = "anthropic:claude-haiku-4-5-20251001";
const STORE_DIR = process.env.EVAL_STORE_DIR ?? "./eval-results";
const EVAL_NAME = "basic-eval";

// ---------------------------------------------------------------------------
// Agent factory — bridges KoiRuntime → AgentHandle
// ---------------------------------------------------------------------------

async function createAgent(): Promise<AgentHandle> {
  const piAdapter = createPiAdapter({
    model: EVAL_MODEL,
    systemPrompt: "You are a concise test assistant. Reply briefly and exactly as instructed.",
    getApiKey: async () => ANTHROPIC_KEY,
  });

  const runtime = await createKoi({
    manifest: {
      name: "eval-basic-agent",
      version: "1.0.0",
      model: { name: "claude-haiku" },
    },
    adapter: piAdapter,
    middleware: [],
    loopDetection: false,
    limits: { maxTurns: 3, maxDurationMs: 30_000, maxTokens: 5_000 },
  });

  return {
    stream: (input: EngineInput) => runtime.run(input),
    dispose: () => runtime.dispose(),
  };
}

// ---------------------------------------------------------------------------
// Eval tasks
// ---------------------------------------------------------------------------

const TASKS: readonly EvalTask[] = [
  {
    id: "ping-pong",
    name: "Ping-Pong",
    input: { kind: "text", text: "Reply with exactly one word: pong" },
    expected: { kind: "text", pattern: /pong/i },
    graders: [createExactMatchGrader()],
  },
  {
    id: "simple-math",
    name: "Simple Math",
    input: { kind: "text", text: "What is 2 + 2? Reply with just the number." },
    expected: { kind: "text", pattern: "4" },
    graders: [createExactMatchGrader()],
  },
  {
    id: "json-output",
    name: "JSON Output",
    input: {
      kind: "text",
      text: 'Return a JSON object with exactly two fields: "name" (a string) and "age" (a number). No other text.',
    },
    graders: [
      createJsonSchemaGrader({
        schema: {
          type: "object",
          required: ["name", "age"],
          properties: {
            name: { type: "string", minLength: 1 },
            age: { type: "number" },
          },
        },
      }),
    ],
  },
  {
    id: "color-list",
    name: "Color List",
    input: { kind: "text", text: "List exactly 3 primary colors, one per line. Nothing else." },
    expected: { kind: "text", pattern: /red/i },
    graders: [createExactMatchGrader({ caseSensitive: false })],
  },
  {
    id: "capital-city",
    name: "Capital City",
    input: { kind: "text", text: "What is the capital of France? Reply with one word only." },
    expected: { kind: "text", pattern: /paris/i },
    graders: [createExactMatchGrader()],
    trialCount: 3,
  },
];

// ---------------------------------------------------------------------------
// Main — run → store → regress → report → exit
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Running eval suite: ${EVAL_NAME}`);
  console.log(`Model: ${EVAL_MODEL}`);
  console.log(`Tasks: ${String(TASKS.length)}`);
  console.log("");

  const runner = createEvalRunner({
    name: EVAL_NAME,
    tasks: TASKS,
    agentFactory: createAgent,
    concurrency: 3,
    timeoutMs: 30_000,
    passThreshold: 0.5,
    onTrialComplete: (trial) => {
      const icon = trial.status === "pass" ? "+" : trial.status === "fail" ? "x" : "!";
      console.log(`  [${icon}] ${trial.taskId} #${String(trial.trialIndex)}: ${trial.status}`);
    },
  });

  const run = await runner.run();

  // Persist results to disk
  const store = createFsEvalStore({ baseDir: STORE_DIR });
  await store.save(run);
  console.log(`\nResults saved to: ${STORE_DIR}/${EVAL_NAME}/`);

  // Regression check against previous baseline
  const baseline = await store.latest(EVAL_NAME);
  const regression =
    baseline !== undefined && baseline.id !== run.id
      ? detectRegression(baseline.summary, run.summary)
      : undefined;

  // CI report with exit code
  const report = formatCiReport(run, regression);
  console.log("");
  console.log(report.summary);

  process.exit(report.exitCode);
}

main().catch((err: unknown) => {
  console.error("Eval failed:", err);
  process.exit(1);
});
