/**
 * @koi/loop — public type definitions.
 *
 * L2 package. Imports only from @koi/core (L0). No logic lives in this file;
 * pure type declarations only, per L0-style discipline.
 */

import type { EngineEvent } from "@koi/core";

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/**
 * Structural runtime interface. Intentionally does NOT import @koi/engine (L1);
 * any caller that can produce an EngineEvent stream from a text prompt plugs
 * in here — the harness, a test fake, a cassette replayer, etc.
 */
export interface LoopRuntime {
  readonly run: (input: {
    readonly kind: "text";
    readonly text: string;
    readonly signal?: AbortSignal;
  }) => AsyncIterable<EngineEvent>;
}

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

/**
 * Why the verifier declared the attempt a failure. Kept as a small closed
 * union so the prompt rebuilder and telemetry can branch on it without
 * string parsing.
 */
export type VerifierFailureReason =
  | "exit_nonzero"
  | "spawn_error"
  | "timeout"
  | "aborted"
  | "predicate_threw"
  | "file_missing"
  | "file_no_match"
  /**
   * The iteration failed BEFORE the verifier ran (no done event, stream
   * error, stopReason != "completed", iteration timeout, cleanup timeout).
   * The surrounding IterationRecord's `runtimeError` field carries the
   * actual message. Callers inspecting the verifierResult can distinguish
   * "verifier said no" from "we never got to the verifier".
   */
  | "runtime_error"
  /**
   * The iteration completed successfully, but the verifier was
   * intentionally skipped because the cumulative token budget hit the
   * hard cap after this iteration's spend was added. The iteration
   * itself is NOT a failure — the loop terminated because further
   * verification would have exceeded the stop condition. Used only
   * when `runUntilPass` short-circuits the verifier phase to avoid
   * extra side-effecting work after the budget is blown.
   */
  | "skipped_budget_exhausted";

export type VerifierResult =
  | { readonly ok: true; readonly details?: string }
  | {
      readonly ok: false;
      readonly reason: VerifierFailureReason;
      readonly details: string;
      readonly exitCode?: number;
    };

export interface VerifierContext {
  readonly iteration: number;
  readonly workingDir: string;
  readonly signal: AbortSignal;
}

export interface Verifier {
  readonly check: (ctx: VerifierContext) => Promise<VerifierResult>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Budget disposition. `"unmetered"` is explicit so that the absence of token
 * accounting is never ambiguous — no "maybe 0, maybe unknown" wart.
 */
export type TokenBudget = number | "unmetered";

export interface RunUntilPassConfig {
  readonly runtime: LoopRuntime;
  readonly verifier: Verifier;
  readonly initialPrompt: string;

  /**
   * REQUIRED. There is intentionally no silent process.cwd() default —
   * running a verifier in the wrong directory is a class of silent bug we
   * refuse to enable.
   */
  readonly workingDir: string;

  readonly rebuildPrompt?: (ctx: RebuildPromptContext) => string;

  readonly maxIterations?: number;
  readonly maxBudgetTokens?: TokenBudget;
  readonly iterationTimeoutMs?: number;
  readonly verifierTimeoutMs?: number;
  readonly maxConsecutiveFailures?: number;

  readonly signal?: AbortSignal;
  readonly onEvent?: (event: LoopEvent) => void;
}

export interface RebuildPromptContext {
  /** Iteration number for the prompt being built (2..N). */
  readonly iteration: number;
  readonly initialPrompt: string;
  /** Always `ok: false` — rebuildPrompt is not called on convergence. */
  readonly latestFailure: VerifierResult;
  /** Last 3 failures (most recent last), each pre-truncated to 2 KB. */
  readonly recentFailures: readonly VerifierResult[];
  readonly tokensConsumed: TokenBudget;
}

// ---------------------------------------------------------------------------
// Result & events
// ---------------------------------------------------------------------------

/**
 * Terminal state of the loop — exactly one of these is reached on every run.
 * Mirrors the state machine diagram in docs/L2/loop.md.
 */
export type LoopStatus = "converged" | "exhausted" | "aborted" | "circuit_broken" | "errored";

export interface IterationRecord {
  readonly iteration: number;
  readonly durationMs: number;
  readonly tokensConsumed: TokenBudget;
  readonly verifierResult: VerifierResult;
  /** Set if runtime.run itself failed (zero events, no done, stream error). */
  readonly runtimeError?: string;
}

export interface RunUntilPassResult {
  readonly status: LoopStatus;
  readonly iterations: number;
  readonly tokensConsumed: TokenBudget;
  readonly durationMs: number;
  readonly iterationRecords: readonly IterationRecord[];
  readonly terminalReason: string;
}

export type LoopEvent =
  | {
      readonly kind: "loop.iteration.start";
      readonly iteration: number;
      readonly prompt: string;
    }
  | {
      readonly kind: "loop.iteration.complete";
      readonly record: IterationRecord;
    }
  | {
      readonly kind: "loop.verifier.start";
      readonly iteration: number;
    }
  | {
      readonly kind: "loop.verifier.complete";
      readonly iteration: number;
      readonly result: VerifierResult;
    }
  | {
      readonly kind: "loop.terminal";
      readonly result: RunUntilPassResult;
    };

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Canonical default values. Exported so tests can assert against them and
 * callers can reference them when layering higher-level wrappers.
 */
interface LoopDefaults {
  readonly maxIterations: number;
  readonly maxBudgetTokens: TokenBudget;
  readonly iterationTimeoutMs: number;
  readonly verifierTimeoutMs: number;
  readonly maxConsecutiveFailures: number;
  readonly failureDetailsBytes: number;
  readonly recentFailuresWindow: number;
  readonly argvStderrBytes: number;
}

export const LOOP_DEFAULTS: LoopDefaults = {
  maxIterations: 10,
  maxBudgetTokens: "unmetered",
  iterationTimeoutMs: 10 * 60_000,
  verifierTimeoutMs: 2 * 60_000,
  maxConsecutiveFailures: 3,
  failureDetailsBytes: 2 * 1024,
  recentFailuresWindow: 3,
  argvStderrBytes: 2 * 1024,
};
