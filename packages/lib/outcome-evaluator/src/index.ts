/**
 * @koi/outcome-evaluator — Rubric-graded LLM-as-judge iteration loop.
 *
 * Evaluates agent output against a structured rubric using a separate grader
 * model call. Re-prompts with per-criterion feedback until all required criteria
 * pass or the iteration budget is exhausted.
 *
 * Usage:
 *   const { middleware } = createOutcomeEvaluatorMiddleware({
 *     rubric: { description: "...", criteria: [...] },
 *     graderModelCall: (prompt, signal) => myModel.complete(prompt, { signal }),
 *     maxIterations: 5,
 *   });
 *
 *   // Ensure EngineInput.maxStopRetries >= maxIterations
 *   await runtime.run({ kind: "text", text: "...", maxStopRetries: 5 });
 */

export { createOutcomeEvaluatorMiddleware } from "./outcome-evaluator.js";
export type {
  GraderModelCall,
  OutcomeEvaluationEvent,
  OutcomeEvaluatorConfig,
  OutcomeEvaluatorHandle,
  OutcomeEvaluatorStats,
} from "./types.js";
