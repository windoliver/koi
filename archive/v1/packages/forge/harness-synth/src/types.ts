/**
 * Types for the harness synthesis pipeline.
 *
 * harness-synth transforms observed failures into middleware code via LLM.
 */

import type { ToolDescriptor } from "@koi/core";
import type { FailureRecordBase } from "@koi/failure-context";

// ---------------------------------------------------------------------------
// Failure records
// ---------------------------------------------------------------------------

/** A failure record enriched with tool context for synthesis. */
export interface ToolFailureRecord extends FailureRecordBase {
  readonly toolName: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  /** Agent's stated goal at the time of failure (if available). */
  readonly agentGoal?: string | undefined;
  /** Provenance tag — used for recursion prevention. */
  readonly forgedBy?: string | undefined;
}

/** Deduplicated, filtered failures ready for synthesis. */
export interface QualifiedFailures {
  /** Distinct failure groups after dedup and filtering. */
  readonly failures: readonly ToolFailureRecord[];
  /** Number of raw failures before dedup. */
  readonly rawCount: number;
  /** Number removed by dedup. */
  readonly deduplicatedCount: number;
  /** Number removed by staleness filter. */
  readonly staleCount: number;
  /** Distinct error pattern clusters. */
  readonly clusterCount: number;
}

// ---------------------------------------------------------------------------
// Aggregation config
// ---------------------------------------------------------------------------

export interface AggregatorConfig {
  /** Minimum distinct failures required to trigger synthesis. Default: 3. */
  readonly minFailures: number;
  /** Max age in ms for a failure to be considered current. Default: 3600000 (1 hour). */
  readonly maxAgeMs: number;
  /** Provenance tags to exclude (recursion prevention). Default: ["harness-synth"]. */
  readonly excludeForgedBy: readonly string[];
}

export const DEFAULT_AGGREGATOR_CONFIG: AggregatorConfig = Object.freeze({
  minFailures: 3,
  maxAgeMs: 3_600_000,
  excludeForgedBy: ["harness-synth"],
} as const);

// ---------------------------------------------------------------------------
// Synthesis types
// ---------------------------------------------------------------------------

/** Input to the synthesis pipeline. */
export interface SynthesisInput {
  readonly failures: QualifiedFailures;
  /** Name of the tool the middleware will protect. */
  readonly targetToolName: string;
  /** Schema of the target tool (if available). */
  readonly targetToolSchema?: Readonly<Record<string, unknown>> | undefined;
}

/** LLM-generated output from synthesis. */
export interface SynthesisOutput {
  /** Generated wrapToolCall middleware source code. */
  readonly code: string;
  /** Parsed tool descriptor for the synthesized middleware. */
  readonly descriptor: ToolDescriptor;
  /** How many LLM calls were needed. */
  readonly iterationCount: number;
}

/** Result of a synthesis attempt. */
export type SynthesisResult =
  | { readonly ok: true; readonly value: SynthesisOutput }
  | { readonly ok: false; readonly reason: string };

// ---------------------------------------------------------------------------
// Synthesis config
// ---------------------------------------------------------------------------

/** Callback to generate code from a prompt. Injected by L3 wiring. */
export type GenerateCallback = (prompt: string) => Promise<string>;

export interface SynthesisConfig {
  /** LLM generation callback — injected by L3 meta-package. */
  readonly generate: GenerateCallback;
  /** Maximum iterations per synthesis attempt. Default: 20. */
  readonly maxIterations: number;
  /** Clock function for timestamps. Default: Date.now. */
  readonly clock: () => number;
}

export const DEFAULT_SYNTHESIS_CONFIG: Pick<SynthesisConfig, "maxIterations" | "clock"> =
  Object.freeze({
    maxIterations: 20,
    clock: Date.now,
  } as const);
