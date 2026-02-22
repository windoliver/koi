/**
 * Stage 4: Trust tier assignment — determines the trust level for a forged brick.
 */

import type { Result, TrustTier } from "@koi/core";
import type { ForgeConfig } from "./config.js";
import type { ForgeError } from "./errors.js";
import { trustError } from "./errors.js";
import type { ForgeInput, StageReport, TrustStageReport } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function assignTrust(
  _input: ForgeInput,
  config: ForgeConfig,
  stageResults: readonly StageReport[],
): Result<TrustStageReport, ForgeError> {
  const start = performance.now();

  // All prior stages must have passed
  for (const stage of stageResults) {
    if (!stage.passed) {
      return {
        ok: false,
        error: trustError(
          "GOVERNANCE_REJECTED",
          `Cannot assign trust: stage "${stage.stage}" did not pass`,
        ),
      };
    }
  }

  // Trust never exceeds "verified" via automated pipeline
  // "promoted" requires human-in-the-loop
  const tier: TrustTier =
    config.defaultTrustTier === "promoted" ? "verified" : config.defaultTrustTier;

  const durationMs = performance.now() - start;
  return {
    ok: true,
    value: {
      stage: "trust",
      passed: true,
      durationMs,
      trustTier: tier,
    },
  };
}
