/**
 * Bridge function — maps KoiConfig to the engine's CreateKoiOptions shape.
 *
 * This is the glue between @koi/config (L2) and @koi/engine (L1).
 * It reads from KoiConfig and produces the options subset that engine cares about:
 * limits, loopDetection, and spawn. The caller still provides manifest + adapter.
 */

import type { KoiConfig } from "@koi/core";

// ---------------------------------------------------------------------------
// Bridge output type (matches CreateKoiOptions subset without framework types)
// ---------------------------------------------------------------------------

/**
 * Engine-compatible options derived from KoiConfig.
 * These map 1:1 to the corresponding CreateKoiOptions fields.
 */
export interface ResolvedKoiOptions {
  readonly limits: {
    readonly maxTurns: number;
    readonly maxDurationMs: number;
    readonly maxTokens: number;
  };
  readonly loopDetection:
    | {
        readonly windowSize: number;
        readonly threshold: number;
        readonly warningThreshold?: number;
      }
    | false;
  readonly spawn: {
    readonly maxDepth: number;
    readonly maxFanOut: number;
    readonly maxTotalProcesses: number;
    readonly spawnToolIds?: readonly string[];
  };
}

// ---------------------------------------------------------------------------
// Bridge function
// ---------------------------------------------------------------------------

/**
 * Extracts engine-compatible options from a KoiConfig.
 *
 * @param config - The resolved KoiConfig.
 * @param overrides - Optional partial overrides applied last.
 * @returns Options that can be spread into CreateKoiOptions.
 */
export function resolveKoiOptions(
  config: KoiConfig,
  overrides?: Partial<ResolvedKoiOptions>,
): ResolvedKoiOptions {
  const limits = overrides?.limits ?? {
    maxTurns: config.limits.maxTurns,
    maxDurationMs: config.limits.maxDurationMs,
    maxTokens: config.limits.maxTokens,
  };

  const loopDetection: ResolvedKoiOptions["loopDetection"] = (() => {
    if (overrides?.loopDetection !== undefined) {
      return overrides.loopDetection;
    }
    if (!config.loopDetection.enabled) {
      return false;
    }
    return {
      windowSize: config.loopDetection.windowSize,
      threshold: config.loopDetection.threshold,
      ...(config.loopDetection.warningThreshold !== undefined
        ? { warningThreshold: config.loopDetection.warningThreshold }
        : {}),
    };
  })();

  const spawn = overrides?.spawn ?? {
    maxDepth: config.spawn.maxDepth,
    maxFanOut: config.spawn.maxFanOut,
    maxTotalProcesses: config.spawn.maxTotalProcesses,
    ...(config.spawn.spawnToolIds !== undefined ? { spawnToolIds: config.spawn.spawnToolIds } : {}),
  };

  return { limits, loopDetection, spawn };
}
