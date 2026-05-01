/**
 * @koi/eval — agent evaluation framework + self-test.
 *
 * Define eval suites, run against an agent, score transcripts with pluggable
 * graders, persist runs for regression detection, and gate capabilities with
 * a thin self-test layer.
 *
 * Usage:
 *   const run = await runEval({
 *     name: "smoke",
 *     tasks: [{ id: "t1", name: "greets", input: { kind: "text", text: "hi" },
 *               expected: { kind: "text", pattern: /hello/i },
 *               graders: [exactMatch()] }],
 *     agentFactory: () => myAgent,
 *   });
 *   await store.save(run);
 *   const baseline = await store.latest("smoke");
 *   const regression = compareRuns(baseline, run);
 */

export type { ExactMatchOptions } from "./graders/exact-match.js";
export { exactMatch } from "./graders/exact-match.js";
export type { ToolCallOptions } from "./graders/tool-call.js";
export { toolCall } from "./graders/tool-call.js";
export { compareRuns } from "./regression.js";
export { runEval } from "./runner.js";
export { runSelfTest, SELF_TEST_ABORT_REASON } from "./self-test.js";
export { createFsStore } from "./store.js";
export type {
  AgentHandle,
  CancellationStatus,
  CheckResult,
  EvalDefaults,
  EvalExpectation,
  EvalGrader,
  EvalRun,
  EvalRunConfig,
  EvalRunConfigSnapshot,
  EvalRunMeta,
  EvalScore,
  EvalStore,
  EvalStoreSaveOptions,
  EvalSummary,
  EvalTask,
  EvalTrial,
  ExpectedToolCall,
  RegressionDetail,
  RegressionResult,
  RegressionThresholds,
  SelfTestCheck,
  SelfTestCheckResult,
  SelfTestOptions,
  SelfTestResult,
  TaskSummary,
} from "./types.js";
export { EVAL_DEFAULTS } from "./types.js";
