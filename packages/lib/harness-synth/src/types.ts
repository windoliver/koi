/**
 * Types for the @koi/harness-synth pipeline.
 *
 * Public surface — these types describe inputs, outputs, and the two
 * caller-injected callbacks (generate, verify). The package itself owns
 * no I/O: callers wrap their LLM and verifier behind these signatures.
 */

import type { ToolDescriptor } from "@koi/core";
import type { ForgeCandidate } from "@koi/forge-types";

/** Provenance tag stamped on every synthesized output. */
export const FORGED_BY = "harness-synth";

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Discriminated verification result returned by the injected `verify`
 * callback. Kept narrower than `ForgeVerificationSummary` so callers can
 * adapt any verifier (forge-verifier, ad-hoc test runners, mocks).
 */
export type VerifyResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Caller-supplied verifier. Receives parsed code + descriptor. */
export type VerifyCallback = (
  code: string,
  descriptor: ToolDescriptor,
) => Promise<VerifyResult> | VerifyResult;

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** Caller-supplied LLM. Pure prompt-in / text-out so it is easy to fake. */
export type GenerateCallback = (prompt: string) => Promise<string>;

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
}

/** Defaults applied when fields are omitted from a partial config. */
export const DEFAULT_SYNTHESIS_CONFIG: Pick<SynthesisConfig, "maxAttempts" | "clock"> =
  Object.freeze({
    maxAttempts: 3,
    clock: Date.now,
  });
