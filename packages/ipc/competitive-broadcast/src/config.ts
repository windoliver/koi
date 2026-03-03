/**
 * Cycle configuration validation and defaults.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { BroadcastSink, CycleEvent, SelectionStrategy } from "./types.js";

// ---------------------------------------------------------------------------
// CycleConfig
// ---------------------------------------------------------------------------

/** Configuration for a single competitive broadcast cycle. */
export interface CycleConfig {
  readonly strategy: SelectionStrategy;
  readonly sink: BroadcastSink;
  /** Minimum number of proposals required to run a cycle. Default: 1. */
  readonly minProposals: number;
  /** Maximum characters per proposal output. Truncated before selection. Default: 10,000. */
  readonly maxOutputPerProposal: number;
  /** Optional abort signal for cycle cancellation. */
  readonly signal?: AbortSignal | undefined;
  /** Optional callback for cycle lifecycle events. */
  readonly onEvent?: ((event: CycleEvent) => void) | undefined;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CYCLE_CONFIG: Readonly<{
  readonly minProposals: 1;
  readonly maxOutputPerProposal: 10_000;
}> = Object.freeze({
  minProposals: 1,
  maxOutputPerProposal: 10_000,
} as const);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validationError(message: string): Result<CycleConfig, KoiError> {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    },
  };
}

/** Validates an unknown value as a CycleConfig. Applies defaults for optional fields. */
export function validateCycleConfig(config: unknown): Result<CycleConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return validationError("Config must be a non-null object");
  }

  const c = config as Record<string, unknown>;

  // Required: strategy
  if (c.strategy === null || c.strategy === undefined || typeof c.strategy !== "object") {
    return validationError("Config must include a strategy object");
  }
  const strategy = c.strategy as Record<string, unknown>;
  if (typeof strategy.select !== "function") {
    return validationError("Config must include strategy.select as a function");
  }

  // Required: sink
  if (c.sink === null || c.sink === undefined || typeof c.sink !== "object") {
    return validationError("Config must include a sink object");
  }
  const sink = c.sink as Record<string, unknown>;
  if (typeof sink.broadcast !== "function") {
    return validationError("Config must include sink.broadcast as a function");
  }

  // Optional: minProposals
  const minProposals =
    c.minProposals !== undefined ? (c.minProposals as number) : DEFAULT_CYCLE_CONFIG.minProposals;
  if (typeof minProposals !== "number" || !Number.isInteger(minProposals) || minProposals < 1) {
    return validationError("minProposals must be a positive integer (>= 1)");
  }

  // Optional: maxOutputPerProposal
  const maxOutputPerProposal =
    c.maxOutputPerProposal !== undefined
      ? (c.maxOutputPerProposal as number)
      : DEFAULT_CYCLE_CONFIG.maxOutputPerProposal;
  if (typeof maxOutputPerProposal !== "number" || maxOutputPerProposal < 0) {
    return validationError("maxOutputPerProposal must be a non-negative number");
  }

  return {
    ok: true,
    value: {
      strategy: c.strategy as SelectionStrategy,
      sink: c.sink as BroadcastSink,
      minProposals,
      maxOutputPerProposal,
      signal: c.signal as AbortSignal | undefined,
      onEvent: c.onEvent as ((event: CycleEvent) => void) | undefined,
    },
  };
}
