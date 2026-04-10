import { resolveThresholds } from "./resolve-thresholds.js";
import type { CompactionManagerConfig, CompactionState } from "./types.js";

export function rehydrateConfig(
  state: CompactionState,
  config: CompactionManagerConfig | undefined,
  newModelId: string,
): CompactionState {
  return {
    ...state,
    consecutiveFailures: 0,
    skipUntilTurn: 0,
    resolvedPolicy: resolveThresholds(config, newModelId),
  };
}
