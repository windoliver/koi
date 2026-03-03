/**
 * Core competitive broadcast cycle pipeline.
 *
 * runCycle() validates → truncates → selects → broadcasts → returns Result.
 * Stateless — safe to call concurrently.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { CycleConfig } from "./config.js";
import type { BroadcastResult, CycleEvent, Proposal } from "./types.js";

// ---------------------------------------------------------------------------
// Truncation helper (~5 lines, copied from parallel-minions pattern)
// ---------------------------------------------------------------------------

const TRUNCATION_MARKER = "\n... [output truncated]";

function truncateOutput(output: string, maxLen: number): string {
  if (output.length <= maxLen) return output;
  const contentLen = Math.max(0, maxLen - TRUNCATION_MARKER.length);
  return output.slice(0, contentLen) + TRUNCATION_MARKER;
}

// ---------------------------------------------------------------------------
// Cycle ID generator
// ---------------------------------------------------------------------------

function generateCycleId(): string {
  return `cycle-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validationError(message: string): KoiError {
  return {
    code: "VALIDATION",
    message,
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
  };
}

function abortError(message: string): KoiError {
  return {
    code: "TIMEOUT",
    message,
    retryable: RETRYABLE_DEFAULTS.TIMEOUT,
  };
}

function internalError(message: string, cause: unknown): KoiError {
  return {
    code: "INTERNAL",
    message,
    retryable: RETRYABLE_DEFAULTS.INTERNAL,
    cause,
  };
}

// ---------------------------------------------------------------------------
// Safe event emit
// ---------------------------------------------------------------------------

function emitEvent(config: CycleConfig, event: CycleEvent): void {
  if (config.onEvent !== undefined) {
    try {
      config.onEvent(event);
    } catch {
      /* onEvent is observability-only — never let it crash the cycle */
    }
  }
}

// ---------------------------------------------------------------------------
// runCycle
// ---------------------------------------------------------------------------

/**
 * Executes a competitive broadcast cycle:
 * 1. Validate proposals (count, duplicates, abort signal)
 * 2. Truncate outputs to maxOutputPerProposal
 * 3. Run selection strategy
 * 4. Broadcast winner to sink
 *
 * Returns Result — never throws.
 */
export async function runCycle(
  config: CycleConfig,
  proposals: readonly Proposal[],
): Promise<Result<BroadcastResult, KoiError>> {
  // 1. Check abort signal
  if (config.signal?.aborted === true) {
    const error = abortError("Cycle aborted before start");
    emitEvent(config, { kind: "cycle_error", error });
    return { ok: false, error };
  }

  // 2. Validate proposal count
  if (proposals.length < config.minProposals) {
    const error = validationError(
      proposals.length === 0
        ? "Cannot run cycle with zero proposals"
        : `Received ${proposals.length} proposals but minimum is ${config.minProposals}`,
    );
    emitEvent(config, { kind: "cycle_error", error });
    return { ok: false, error };
  }

  // 3. Check for duplicate IDs
  const ids = new Set<string>();
  for (const p of proposals) {
    if (ids.has(p.id)) {
      const error = validationError(`Found duplicate proposal ID: ${p.id}`);
      emitEvent(config, { kind: "cycle_error", error });
      return { ok: false, error };
    }
    ids.add(p.id);
  }

  // 4. Truncate outputs
  const truncated: readonly Proposal[] = proposals.map((p) => {
    const output = truncateOutput(p.output, config.maxOutputPerProposal);
    return output === p.output ? p : { ...p, output };
  });

  // 5. Selection
  emitEvent(config, { kind: "selection_started", proposalCount: truncated.length });

  /* let is required because selectResult is set in try/catch */
  let selectResult: Result<Proposal, KoiError>;
  try {
    selectResult = await config.strategy.select(truncated);
  } catch (e: unknown) {
    const error = internalError("Selection failed unexpectedly", e);
    emitEvent(config, { kind: "cycle_error", error });
    return { ok: false, error };
  }

  if (!selectResult.ok) {
    emitEvent(config, { kind: "cycle_error", error: selectResult.error });
    return selectResult;
  }

  const winner = selectResult.value;
  emitEvent(config, { kind: "winner_selected", winner });

  // 6. Check abort signal after selection (re-read to catch mid-cycle abort)
  if (config.signal?.aborted) {
    const error = abortError("Cycle aborted after selection but before broadcast");
    emitEvent(config, { kind: "cycle_error", error });
    return { ok: false, error };
  }

  // 7. Broadcast
  const cycleId = generateCycleId();
  const broadcastPayload: BroadcastResult = {
    winner,
    allProposals: truncated,
    cycleId,
  };

  emitEvent(config, { kind: "broadcast_started", winnerId: winner.id });

  try {
    const report = await config.sink.broadcast(broadcastPayload);
    emitEvent(config, { kind: "broadcast_complete", report });
    return { ok: true, value: broadcastPayload };
  } catch (e: unknown) {
    const error = internalError("Broadcast failed unexpectedly", e);
    emitEvent(config, { kind: "cycle_error", error });
    return { ok: false, error };
  }
}
