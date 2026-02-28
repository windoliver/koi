/**
 * Budget presets for context-arena.
 *
 * Each preset defines fraction-based parameters that are multiplied by the
 * context window size to produce absolute token budgets. The arena allocator
 * mental model: one call sites all budget decisions.
 */

import type { ContextArenaPreset, PresetBudget, PresetSpec } from "./types.js";

// ---------------------------------------------------------------------------
// Preset specifications
// ---------------------------------------------------------------------------

const CONSERVATIVE: PresetSpec = Object.freeze({
  triggerFraction: 0.5,
  softTriggerOffset: 0.1,
  preserveRecent: 6,
  summaryTokenFraction: 0.005,
  editingTriggerFraction: 0.4,
  editingRecentToKeep: 4,
  maxPendingSquashes: 2,
});

const BALANCED: PresetSpec = Object.freeze({
  triggerFraction: 0.6,
  softTriggerOffset: 0.1,
  preserveRecent: 4,
  summaryTokenFraction: 0.005,
  editingTriggerFraction: 0.5,
  editingRecentToKeep: 3,
  maxPendingSquashes: 3,
});

const AGGRESSIVE: PresetSpec = Object.freeze({
  triggerFraction: 0.75,
  softTriggerOffset: 0.1,
  preserveRecent: 3,
  summaryTokenFraction: 0.0075,
  editingTriggerFraction: 0.6,
  editingRecentToKeep: 2,
  maxPendingSquashes: 4,
});

/** All preset specifications keyed by name. */
export const PRESET_SPECS: Readonly<Record<ContextArenaPreset, PresetSpec>> = Object.freeze({
  conservative: CONSERVATIVE,
  balanced: BALANCED,
  aggressive: AGGRESSIVE,
});

// ---------------------------------------------------------------------------
// Budget computation
// ---------------------------------------------------------------------------

/**
 * Derives absolute budget values from a preset and context window size.
 *
 * Key invariant: `editingTriggerTokenCount < compactorTriggerFraction * contextWindowSize`
 * — editing clears stale tool results (cheap) before compaction (expensive LLM call) fires.
 */
export function computePresetBudget(
  preset: ContextArenaPreset,
  contextWindowSize: number,
): PresetBudget {
  const spec = PRESET_SPECS[preset];
  return {
    compactorTriggerFraction: spec.triggerFraction,
    compactorSoftTriggerFraction: spec.triggerFraction - spec.softTriggerOffset,
    compactorPreserveRecent: spec.preserveRecent,
    compactorMaxSummaryTokens: Math.round(contextWindowSize * spec.summaryTokenFraction),
    editingTriggerTokenCount: Math.round(contextWindowSize * spec.editingTriggerFraction),
    editingNumRecentToKeep: spec.editingRecentToKeep,
    squashPreserveRecent: spec.preserveRecent,
    squashMaxPendingSquashes: spec.maxPendingSquashes,
  };
}
