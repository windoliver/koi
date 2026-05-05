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
 * callback. Success MUST carry a populated `ForgeVerificationSummary` —
 * downstream provenance / publication / audit need per-stage evidence
 * for the winning attempt, and a missing summary leaves nothing to
 * triage when a bad artifact slips through. Test verifiers can supply
 * a minimal stub summary; the package treats summary-less success as
 * a typed verifier failure.
 */
export type VerifyResult =
  | { readonly ok: true; readonly summary: ForgeVerificationSummary }
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
  /**
   * Required input schema for the target tool. The synthesized
   * `descriptor.inputSchema` must structurally equal this — synthesis
   * cannot succeed with a different input contract than the intended
   * tool, otherwise downstream callers using the original schema would
   * fail at invocation time.
   */
  readonly targetToolSchema: Readonly<Record<string, unknown>>;
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
   * Verification evidence produced by the verifier on the passing
   * attempt. Required (see `VerifyResult`); forwarded so downstream
   * forge publication / audit records the exact verification result
   * that succeeded instead of re-running the verifier (which can
   * diverge).
   */
  readonly verification: ForgeVerificationSummary;
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
   * Per-attempt timeout in ms. Default 30_000. Healthy work is given the
   * FULL configured budget; the timer fires after `attemptTimeoutMs`
   * without reserving any slack. Only AFTER a timeout actually fires
   * does the loop wait up to `graceMs = min(1000, timeoutMs/2)` for the
   * aborted callback to unwind before starting the next attempt — so a
   * timed-out attempt's wall-clock cost is `attemptTimeoutMs + graceMs`
   * in the worst case, but a non-timed-out attempt sees no overhead at
   * all. Set to `Infinity` to disable; never set to 0 (would fail every
   * attempt).
   */
  readonly attemptTimeoutMs: number;
  /**
   * Caller's assertion that BOTH `generate` and `verify` honor the
   * `AbortSignal` they receive — i.e. they stop work and release any
   * non-idempotent side effects when aborted. When `false`, the loop
   * forces `maxAttempts = 1`: a timed-out attempt cannot be retried
   * because its side effects may still be in flight, and overlapping
   * a second attempt would duplicate them. This is opt-in: callers
   * wrapping flaky/legacy adapters can keep `false` and lose retries;
   * callers wrapping abort-aware adapters set `true` to enable retries.
   */
  readonly adapterHonorsAbort: boolean;
  /**
   * Caller-supplied sanitizer for caller-injected failure reasons before
   * they are forwarded into the next refinement prompt. Applied to BOTH
   * generator and verifier failures because both wrap adapter-supplied
   * exception messages (sandbox stderr, stack traces, request metadata,
   * tenant data) that cross a trust boundary back into the LLM provider
   * on retry. Internally-generated reasons (parse, schema, timeout) are
   * forwarded as-is — they contain no caller-controlled data.
   *
   * Default: replaces the text with `"failure reason omitted"`. Callers
   * that want the model to see the actual diagnostic must opt in with
   * their own implementation — either pass-through (`(s) => s`) for
   * trusted in-process adapters, or a redactor that strips secrets/PII
   * before returning.
   */
  readonly sanitizeVerifierReason: (reason: string) => string;
}

/**
 * Defaults applied when fields are omitted from a partial config.
 * `adapterHonorsAbort` is deliberately NOT defaulted — every caller must
 * choose strict vs best-effort explicitly.
 */
export const DEFAULT_SYNTHESIS_CONFIG: Pick<
  SynthesisConfig,
  "maxAttempts" | "clock" | "attemptTimeoutMs" | "sanitizeVerifierReason"
> = Object.freeze({
  maxAttempts: 3,
  clock: Date.now,
  attemptTimeoutMs: 30_000,
  sanitizeVerifierReason: (_reason: string): string => "failure reason omitted",
});
