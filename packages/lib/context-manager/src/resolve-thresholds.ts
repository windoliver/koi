import { resolveModelWindow } from "@koi/model-registry";
import type { CompactionManagerConfig, ResolvedCompactionPolicy } from "./types.js";
import { COMPACTION_DEFAULTS } from "./types.js";

export function resolveThresholds(
  config: CompactionManagerConfig | undefined,
  modelId?: string,
): ResolvedCompactionPolicy {
  const effectiveModelId = modelId ?? config?.modelId;

  const contextWindow =
    (effectiveModelId !== undefined
      ? config?.modelWindowOverrides?.[effectiveModelId]
      : undefined) ??
    (effectiveModelId !== undefined
      ? resolveModelWindow(effectiveModelId, config?.modelWindowOverrides)
      : undefined) ??
    config?.contextWindowSize ??
    COMPACTION_DEFAULTS.contextWindowSize;

  const perModelOverride =
    effectiveModelId !== undefined ? config?.perModelPolicy?.[effectiveModelId] : undefined;

  const softTriggerFraction =
    perModelOverride?.softTriggerFraction ??
    config?.globalPolicy?.softTriggerFraction ??
    config?.micro?.triggerFraction ??
    COMPACTION_DEFAULTS.micro.triggerFraction;

  const hardTriggerFraction =
    perModelOverride?.hardTriggerFraction ??
    config?.globalPolicy?.hardTriggerFraction ??
    config?.full?.triggerFraction ??
    COMPACTION_DEFAULTS.full.triggerFraction;

  const prunePreserveLastK =
    perModelOverride?.prunePreserveLastK ??
    config?.globalPolicy?.prunePreserveLastK ??
    COMPACTION_DEFAULTS.prunePreserveLastK;

  return { contextWindow, softTriggerFraction, hardTriggerFraction, prunePreserveLastK };
}
