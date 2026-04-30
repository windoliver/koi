/**
 * @koi/eval — type definitions for the agent evaluation framework.
 *
 * All properties readonly. No class, no enum, no logic.
 */

import type { EngineEvent, EngineInput, EngineMetrics, JsonObject } from "@koi/core";

// ---------------------------------------------------------------------------
// Grader contract
// ---------------------------------------------------------------------------

export interface EvalGrader {
  readonly id: string;
  readonly grade: (
    transcript: readonly EngineEvent[],
    expected: EvalExpectation | undefined,
    metrics: EngineMetrics,
  ) => EvalScore | Promise<EvalScore>;
  /**
   * Stable string capturing this grader instance's configuration
   * (everything that changes its scoring behavior beyond its `id`).
   * Used by `computeTaskFingerprint` so that swapping grader options
   * under a reused taskId surfaces as a regression instead of a
   * false-positive comparison. Optional: graders without config can omit.
   */
  readonly configFingerprint?: string | undefined;
}

export type EvalExpectation =
  | { readonly kind: "text"; readonly pattern: string | RegExp }
  | { readonly kind: "tool_calls"; readonly calls: readonly ExpectedToolCall[] };

export interface ExpectedToolCall {
  readonly toolName: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Task / Trial / Run / Summary
// ---------------------------------------------------------------------------

export interface EvalTask {
  readonly id: string;
  readonly name: string;
  readonly input: EngineInput;
  readonly expected?: EvalExpectation | undefined;
  readonly graders: readonly EvalGrader[];
  /** Number of trials per task. Default: 1. */
  readonly trialCount?: number | undefined;
  /** Per-trial timeout in ms. Default: 60_000. */
  readonly timeoutMs?: number | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly metadata?: JsonObject | undefined;
}

/**
 * Cancellation outcome for a trial:
 *   - "n/a"          — trial completed without cancellation (status pass/fail)
 *   - "confirmed"    — agent acknowledged abort; no background work continues
 *   - "unconfirmed"  — timeout fired but agent did not finish teardown in time;
 *                      side-effects may still be in flight. Treat downstream
 *                      data from this trial as suspect.
 */
export type CancellationStatus = "n/a" | "confirmed" | "unconfirmed";

export interface EvalTrial {
  readonly taskId: string;
  readonly trialIndex: number;
  readonly transcript: readonly EngineEvent[];
  readonly scores: readonly EvalScore[];
  readonly metrics: EngineMetrics;
  readonly status: "pass" | "fail" | "error";
  readonly error?: string | undefined;
  readonly cancellation: CancellationStatus;
}

export interface EvalScore {
  readonly graderId: string;
  readonly score: number;
  readonly pass: boolean;
  readonly reasoning?: string | undefined;
}

export interface EvalRun {
  readonly id: string;
  readonly name: string;
  readonly timestamp: string;
  readonly config: EvalRunConfigSnapshot;
  readonly trials: readonly EvalTrial[];
  readonly summary: EvalSummary;
  /**
   * True when the run was aborted before completing all configured trials.
   * Set when an "unconfirmed" cancellation was observed; remaining tasks
   * are not executed because the leaked agent could overlap with them.
   */
  readonly aborted?: true;
  readonly abortReason?: "cancellation_unconfirmed";
}

export interface EvalRunConfigSnapshot {
  readonly name: string;
  readonly timeoutMs: number;
  readonly passThreshold: number;
  readonly taskCount: number;
}

export interface EvalSummary {
  readonly taskCount: number;
  readonly trialCount: number;
  readonly passRate: number;
  readonly meanScore: number;
  readonly errorCount: number;
  readonly byTask: readonly TaskSummary[];
}

export interface TaskSummary {
  readonly taskId: string;
  readonly taskName: string;
  readonly passRate: number;
  readonly meanScore: number;
  readonly trials: number;
  /**
   * Stable SHA-256 fingerprint of the task definition (input, expected,
   * grader ids). Persisted so regression comparison can refuse to compare
   * runs whose task definitions drifted under a reused taskId.
   */
  readonly taskFingerprint: string;
}

// ---------------------------------------------------------------------------
// Runner config
// ---------------------------------------------------------------------------

export interface EvalRunConfig {
  readonly name: string;
  readonly tasks: readonly EvalTask[];
  readonly agentFactory: () => Promise<AgentHandle> | AgentHandle;
  readonly timeoutMs?: number | undefined;
  /** Max time to wait for an agent's dispose() before abandoning. Default: 5000. */
  readonly disposeTimeoutMs?: number | undefined;
  /** Score >= this = pass. Default: 0.5. */
  readonly passThreshold?: number | undefined;
  readonly onTrialComplete?: ((trial: EvalTrial) => void) | undefined;
  /** Override clock — primarily for tests. */
  readonly now?: (() => number) | undefined;
  /** Override id generator — primarily for tests. */
  readonly idGen?: (() => string) | undefined;
}

export interface AgentHandle {
  readonly stream: (input: EngineInput) => AsyncIterable<EngineEvent>;
  readonly dispose?: () => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface EvalStoreSaveOptions {
  /** Allow overwriting an existing run with the same id. Default: false. */
  readonly overwrite?: boolean | undefined;
}

export interface EvalStore {
  /**
   * Save a run. By default, fails if a run with the same id already exists
   * for this suite — deterministic ids would otherwise silently destroy
   * prior baselines. Pass `{ overwrite: true }` to opt in.
   */
  readonly save: (run: EvalRun, options?: EvalStoreSaveOptions) => Promise<void>;
  /**
   * Load a run by id. Pass `evalName` to disambiguate when run ids may
   * collide across suites; without it, returns undefined if more than one
   * suite holds a run with the given id.
   */
  readonly load: (runId: string, evalName?: string) => Promise<EvalRun | undefined>;
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
// Regression
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
  readonly metric: "passRate" | "meanScore";
  readonly baseline: number;
  readonly current: number;
  readonly delta: number;
}

export interface RegressionThresholds {
  /** Max acceptable pass-rate drop. Default: 0.05. */
  readonly passRateDelta?: number | undefined;
  /** Max acceptable mean-score drop. Default: 0.1. */
  readonly scoreDelta?: number | undefined;
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

export interface SelfTestCheck {
  readonly name: string;
  /**
   * Run the check. Implementations SHOULD listen on `signal` and stop side
   * effects when it aborts; if they cannot, a timed-out check will be
   * reported with `cancellation: "unconfirmed"` so callers know the work
   * may still be in flight.
   */
  readonly run: (signal: AbortSignal) => Promise<CheckResult> | CheckResult;
  readonly timeoutMs?: number | undefined;
}

export interface CheckResult {
  readonly pass: boolean;
  readonly message?: string | undefined;
}

export interface SelfTestOptions {
  /** Default per-check timeout in ms. Default: 5_000. */
  readonly timeoutMs?: number | undefined;
  /** Stop at first failure. Default: false. */
  readonly bail?: boolean | undefined;
}

export interface SelfTestResult {
  readonly pass: boolean;
  readonly checks: readonly SelfTestCheckResult[];
}

export interface SelfTestCheckResult {
  readonly name: string;
  readonly pass: boolean;
  readonly message?: string | undefined;
  readonly durationMs: number;
  /**
   * Cancellation outcome — "unconfirmed" means the check timed out and did
   * not acknowledge the abort signal in time. Callers MUST NOT retry
   * unconfirmed checks blindly: the underlying work may still be running.
   */
  readonly cancellation: CancellationStatus;
}

// ---------------------------------------------------------------------------
// Defaults (codifies invariants from the spec)
// ---------------------------------------------------------------------------

export interface EvalDefaults {
  readonly TIMEOUT_MS: number;
  readonly PASS_THRESHOLD: number;
  readonly TRIAL_COUNT: number;
  readonly PASS_RATE_DELTA: number;
  readonly SCORE_DELTA: number;
  readonly SELF_TEST_TIMEOUT_MS: number;
}

export const EVAL_DEFAULTS: EvalDefaults = {
  TIMEOUT_MS: 60_000,
  PASS_THRESHOLD: 0.5,
  TRIAL_COUNT: 1,
  PASS_RATE_DELTA: 0.05,
  SCORE_DELTA: 0.1,
  SELF_TEST_TIMEOUT_MS: 5_000,
};
