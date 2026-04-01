/**
 * @koi/eval — type definitions for the agent evaluation framework.
 *
 * Follows Anthropic's task/trial/run hierarchy.
 * All properties readonly, no class, no enum.
 */

import type { EngineEvent, EngineInput, EngineMetrics, JsonObject } from "@koi/core";

// ---------------------------------------------------------------------------
// Grader contract
// ---------------------------------------------------------------------------

export interface EvalGrader {
  readonly id: string;
  readonly name: string;
  readonly grade: (
    transcript: readonly EngineEvent[],
    expected: EvalExpectation | undefined,
    metrics: EngineMetrics,
  ) => EvalScore | Promise<EvalScore>;
}

// ---------------------------------------------------------------------------
// Expectation (what we expect from the agent)
// ---------------------------------------------------------------------------

export type EvalExpectation =
  | { readonly kind: "text"; readonly pattern: string | RegExp }
  | { readonly kind: "tool_calls"; readonly calls: readonly ExpectedToolCall[] }
  | {
      readonly kind: "composite";
      readonly expectations: readonly EvalExpectation[];
    }
  | {
      readonly kind: "custom";
      readonly assert: (events: readonly EngineEvent[]) => void | Promise<void>;
    };

export interface ExpectedToolCall {
  readonly toolName: string;
  readonly args?: Readonly<Record<string, unknown>>;
  /** Whether tool call order must match. Default: "any". */
  readonly order?: "strict" | "any";
}

// ---------------------------------------------------------------------------
// Task (the evaluation template)
// ---------------------------------------------------------------------------

export interface EvalTask {
  readonly id: string;
  readonly name: string;
  readonly input: EngineInput;
  readonly expected?: EvalExpectation;
  readonly graders: readonly EvalGrader[];
  /** Number of trials per task. Default: 1. */
  readonly trialCount?: number;
  /** Per-trial timeout in ms. Default: 60_000. */
  readonly timeoutMs?: number;
  readonly tags?: readonly string[];
  readonly metadata?: JsonObject;
}

// ---------------------------------------------------------------------------
// Trial (one execution of a task)
// ---------------------------------------------------------------------------

export interface EvalTrial {
  readonly taskId: string;
  readonly trialIndex: number;
  readonly transcript: readonly EngineEvent[];
  readonly scores: readonly EvalScore[];
  readonly metrics: EngineMetrics;
  readonly status: "pass" | "fail" | "error";
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Score (one grader's assessment)
// ---------------------------------------------------------------------------

export interface EvalScore {
  readonly graderId: string;
  readonly score: number;
  readonly pass: boolean;
  readonly reasoning?: string;
  readonly metadata?: JsonObject;
}

// ---------------------------------------------------------------------------
// Run (the full evaluation session)
// ---------------------------------------------------------------------------

export interface EvalRun {
  readonly id: string;
  readonly name: string;
  readonly timestamp: string;
  readonly config: EvalRunConfigSnapshot;
  readonly trials: readonly EvalTrial[];
  readonly summary: EvalSummary;
}

/**
 * Serializable subset of EvalRunConfig preserved for reproducibility.
 * Excludes functions (agentFactory, onTrialComplete) that cannot be serialized.
 */
export interface EvalRunConfigSnapshot {
  readonly name: string;
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly passThreshold: number;
  readonly taskCount: number;
}

// ---------------------------------------------------------------------------
// Summary (aggregated scores)
// ---------------------------------------------------------------------------

export interface EvalSummary {
  readonly taskCount: number;
  readonly trialCount: number;
  readonly passRate: number;
  readonly passAtK: number;
  readonly passToTheK: number;
  readonly meanScore: number;
  readonly latencyP50Ms: number;
  readonly latencyP95Ms: number;
  readonly totalCostUsd: number;
  readonly byTask: readonly TaskSummary[];
}

export interface TaskSummary {
  readonly taskId: string;
  readonly taskName: string;
  readonly passRate: number;
  readonly passAtK: number;
  readonly passToTheK: number;
  readonly meanScore: number;
  readonly trials: number;
}

// ---------------------------------------------------------------------------
// Runner config
// ---------------------------------------------------------------------------

export interface EvalRunConfig {
  readonly name: string;
  readonly tasks: readonly EvalTask[];
  readonly agentFactory: () => Promise<AgentHandle>;
  /** Max concurrent trials. Default: 5. */
  readonly concurrency?: number;
  /** Per-trial timeout fallback in ms. Default: 60_000. */
  readonly timeoutMs?: number;
  /** Score >= this = pass. Default: 0.5. */
  readonly passThreshold?: number;
  readonly onTrialComplete?: (trial: EvalTrial) => void;
}

// ---------------------------------------------------------------------------
// Agent handle (what the factory returns)
// ---------------------------------------------------------------------------

export interface AgentHandle {
  readonly stream: (input: EngineInput) => AsyncIterable<EngineEvent>;
  readonly dispose?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Store contract
// ---------------------------------------------------------------------------

export interface EvalStore {
  readonly save: (run: EvalRun) => Promise<void>;
  readonly load: (runId: string) => Promise<EvalRun | undefined>;
  readonly latest: (evalName: string) => Promise<EvalRun | undefined>;
  readonly list: (evalName: string) => Promise<readonly EvalRunMeta[]>;
}

export interface EvalRunMeta {
  readonly id: string;
  readonly name: string;
  readonly timestamp: string;
  readonly passRate: number;
  readonly taskCount: number;
}

// ---------------------------------------------------------------------------
// Regression detection
// ---------------------------------------------------------------------------

export type RegressionResult =
  | {
      readonly kind: "pass";
      readonly baseline: EvalSummary;
      readonly current: EvalSummary;
    }
  | {
      readonly kind: "fail";
      readonly regressions: readonly RegressionDetail[];
      readonly baseline: EvalSummary;
      readonly current: EvalSummary;
    }
  | { readonly kind: "no_baseline" };

export interface RegressionDetail {
  readonly taskId: string;
  readonly metric: string;
  readonly baseline: number;
  readonly current: number;
  readonly delta: number;
}

export interface RegressionThresholds {
  /** Max acceptable pass rate drop. Default: 0.05 (5%). */
  readonly passRateDelta?: number;
  /** Max acceptable score drop. Default: 0.1. */
  readonly scoreDelta?: number;
  /** Max acceptable latency multiplier. Default: 2.0. */
  readonly latencyMultiplier?: number;
}

// ---------------------------------------------------------------------------
// LLM judge config
// ---------------------------------------------------------------------------

export type TranscriptMode = "full" | "summary" | "last-n";

export interface LlmJudgeConfig {
  readonly modelCall: (prompt: string) => Promise<string>;
  readonly rubric: string;
  readonly transcriptMode?: TranscriptMode;
  /** For "last-n" mode. Default: 5. */
  readonly lastN?: number;
  readonly parseScore?: (response: string) => number;
}

// ---------------------------------------------------------------------------
// Reporter types
// ---------------------------------------------------------------------------

export interface CiReport {
  readonly exitCode: 0 | 1;
  readonly json: string;
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// Tool call summary (used by transcript helpers)
// ---------------------------------------------------------------------------

export interface ToolCallSummary {
  readonly toolName: string;
  readonly callId: string;
  readonly args?: JsonObject;
}

// ---------------------------------------------------------------------------
// Runner interface
// ---------------------------------------------------------------------------

export interface EvalRunner {
  readonly run: () => Promise<EvalRun>;
}
