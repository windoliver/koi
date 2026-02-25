/**
 * @koi/eval — Agent evaluation framework (Layer 2)
 *
 * Define eval scenarios, run against live or mock agents,
 * score accuracy/tool usage/latency/cost, and detect regressions.
 */

// Config
export {
  DEFAULT_CONCURRENCY,
  DEFAULT_PASS_THRESHOLD,
  DEFAULT_TIMEOUT_MS,
  validateEvalConfig,
} from "./config.js";
// Graders
export { createExactMatchGrader } from "./graders/exact-match.js";
export { createJsonSchemaGrader } from "./graders/json-schema.js";
export { createLlmJudgeGrader } from "./graders/llm-judge.js";
export { createToolCallGrader } from "./graders/tool-call.js";
// Regression
export { detectRegression } from "./regression.js";
// Reporter
export { formatCiReport, formatSummaryTable } from "./reporter.js";
// Runner factory
export { createEvalRunner } from "./runner.js";
// Scorer (for advanced use)
export {
  computePassAtK,
  computePassToTheK,
  computePercentile,
  computeSummary,
} from "./scorer.js";
// Store
export { createFsEvalStore } from "./store/fs-store.js";
// Transcript helpers
export {
  collectTranscript,
  extractMetrics,
  extractText,
  extractToolCalls,
  lastNTurns,
  summarizeTranscript,
} from "./transcript.js";
// Types
export type {
  AgentHandle,
  CiReport,
  EvalExpectation,
  EvalGrader,
  EvalRun,
  EvalRunConfig,
  EvalRunConfigSnapshot,
  EvalRunMeta,
  EvalRunner,
  EvalScore,
  EvalStore,
  EvalSummary,
  EvalTask,
  EvalTrial,
  ExpectedToolCall,
  LlmJudgeConfig,
  RegressionDetail,
  RegressionResult,
  RegressionThresholds,
  TaskSummary,
  ToolCallSummary,
  TranscriptMode,
} from "./types.js";
