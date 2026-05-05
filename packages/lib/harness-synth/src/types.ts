/**
 * Types for the @koi/harness-synth pipeline.
 *
 * Public surface — these types describe inputs, outputs, and the two
 * caller-injected callbacks (generate, verify). The package itself owns
 * no I/O: callers wrap their LLM and verifier behind these signatures.
 */

import type { ForgeVerificationSummary, ToolDescriptor } from "@koi/core";
import type { ForgeCandidate } from "@koi/forge-types";

/** Provenance tag stamped on every synthesized output. */
export const FORGED_BY = "harness-synth";

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Discriminated verification result returned by the injected `verify`
 * callback. Success carries an optional `summary` so the verifier's
 * stage-level evidence (durations, sandbox bit, per-stage digests) can
 * flow into `SynthesisOutput` and on into forge publication/audit paths.
 * `summary` is optional to keep ad-hoc / test verifiers ergonomic.
 */
export type VerifyResult =
  | { readonly ok: true; readonly summary?: ForgeVerificationSummary | undefined }
  | { readonly ok: false; readonly reason: string };

/**
 * Caller-supplied verifier. Receives parsed code, descriptor, and an
 * `AbortSignal` whose abort indicates the synthesis loop has timed out or
 * been cancelled — implementations that wrap non-idempotent work (sandboxed
 * execution, network calls) MUST honor the signal so retries do not leave
 * orphaned attempts running in parallel.
 */
export type VerifyCallback = (
  code: string,
  descriptor: ToolDescriptor,
  signal: AbortSignal,
) => Promise<VerifyResult> | VerifyResult;

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Caller-supplied LLM. The `signal` aborts when the synthesis loop times
 * out or is cancelled by the caller; adapters that wrap network/streaming
 * work MUST honor it so retries don't overlap orphaned generations.
 */
export type GenerateCallback = (prompt: string, signal: AbortSignal) => Promise<string>;

// ---------------------------------------------------------------------------
// Pipeline I/O
// ---------------------------------------------------------------------------

/** Single-candidate synthesis input. */
export interface SynthesisInput {
  readonly candidate: ForgeCandidate;
  /** Name the synthesized tool descriptor must declare. */
  readonly targetToolName: string;
  /** Optional input schema hint forwarded to the prompt. */
  readonly targetToolSchema?: Readonly<Record<string, unknown>> | undefined;
}

/** Successful synthesis output. */
export interface SynthesisOutput {
  /** Generated middleware / tool implementation source code. */
  readonly code: string;
  /** Parsed tool descriptor. `name` is guaranteed to equal `targetToolName`. */
  readonly descriptor: ToolDescriptor;
  /** How many generate→verify cycles were spent (>= 1). */
  readonly attempts: number;
  /** Provenance — always `FORGED_BY`. */
  readonly forgedBy: typeof FORGED_BY;
  /** Wall-clock timestamp from `clock()`. */
  readonly synthesizedAt: number;
  /**
   * Verification evidence produced by the verifier on the passing attempt.
   * Forwarded so downstream forge publication / audit can record the exact
   * verification result that succeeded, instead of re-running the verifier
   * (which can diverge). `undefined` when the verifier opted not to supply
   * a summary (typical for ad-hoc / test verifiers).
   */
  readonly verification?: ForgeVerificationSummary | undefined;
}

/** Discriminated result of a synthesis attempt. */
export type SynthesisResult =
  | { readonly ok: true; readonly value: SynthesisOutput }
  | { readonly ok: false; readonly reason: string; readonly attempts: number };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SynthesisConfig {
  readonly generate: GenerateCallback;
  readonly verify: VerifyCallback;
  /** Hard cap on generate→verify cycles. Default 3. Must be >= 1. */
  readonly maxAttempts: number;
  /** Wall-clock source. Default `Date.now`. */
  readonly clock: () => number;
  /**
   * Caller-supplied cancellation. When the signal aborts, the in-flight
   * attempt is converted to a typed failure and the loop exits without
   * starting another iteration. Has no effect on already-resolved values.
   */
  readonly signal?: AbortSignal | undefined;
  /**
   * Per-attempt hard timeout in ms. Default 30_000. A `generate` or `verify`
   * call that does not settle within the window converts to a typed
   * `{ ok: false, reason: "...timed out..." }` and the loop continues to
   * the next attempt (or exits if `maxAttempts` is exhausted). Set to
   * `Infinity` to disable; never set to 0 (would fail every attempt).
   */
  readonly attemptTimeoutMs: number;
}

/** Defaults applied when fields are omitted from a partial config. */
export const DEFAULT_SYNTHESIS_CONFIG: Pick<
  SynthesisConfig,
  "maxAttempts" | "clock" | "attemptTimeoutMs"
> = Object.freeze({
  maxAttempts: 3,
  clock: Date.now,
  attemptTimeoutMs: 30_000,
});
