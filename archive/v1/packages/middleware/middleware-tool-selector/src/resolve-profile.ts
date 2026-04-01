/**
 * Three-phase profile resolution: Resolve -> Modify -> Cap.
 *
 * Composes a final tool name list from a named profile, optional
 * include/exclude modifiers, and an optional model tier cap.
 */

import type { CapabilityTier } from "./model-tier.js";
import { MODEL_CAPABILITY_TIERS } from "./model-tier.js";
import type { ToolProfileName } from "./tool-profiles.js";
import { TOOL_PROFILES } from "./tool-profiles.js";

/** Input to the composed resolution pipeline. */
export interface ProfileResolutionInput {
  readonly profile: ToolProfileName | "auto";
  readonly tier?: CapabilityTier | undefined;
  readonly include?: readonly string[] | undefined;
  readonly exclude?: readonly string[] | undefined;
}

/** Result of profile resolution. */
export interface ResolvedProfile {
  readonly toolNames: readonly string[];
  readonly isFullProfile: boolean;
}

/** Maps auto profile to the appropriate named profile for a given tier. */
const AUTO_TIER_MAP: Record<CapabilityTier, ToolProfileName> = {
  minimal: "minimal",
  standard: "coding",
  advanced: "coding",
  full: "full",
} as const;

/**
 * Phase 1: Resolve a profile name (or "auto") to a base tool list.
 *
 * For "auto", the tier determines which named profile to use.
 * For a named profile, returns its tool list directly.
 */
function resolveBaseProfile(
  profile: ToolProfileName | "auto",
  tier?: CapabilityTier,
): readonly string[] {
  if (profile === "auto") {
    const resolvedName = AUTO_TIER_MAP[tier ?? "standard"];
    return TOOL_PROFILES[resolvedName];
  }
  return TOOL_PROFILES[profile];
}

/**
 * Phase 2: Apply include/exclude modifiers to a base tool list.
 *
 * - include: adds tools not already present
 * - exclude: removes tools by name
 */
function applyModifiers(
  base: readonly string[],
  include?: readonly string[],
  exclude?: readonly string[],
): readonly string[] {
  const excludeSet = exclude !== undefined ? new Set(exclude) : undefined;

  // Start with base, exclude any in the exclude set
  const filtered =
    excludeSet !== undefined ? base.filter((name) => !excludeSet.has(name)) : [...base];

  // Add included names not already present
  if (include !== undefined) {
    const existing = new Set(filtered);
    const additions = include.filter((name) => !existing.has(name));
    return [...filtered, ...additions];
  }

  return filtered;
}

/**
 * Phase 3: Cap tool count by model tier limit.
 *
 * If the list exceeds the tier's maxTools, truncate to fit.
 */
function applyTierCap(tools: readonly string[], tier: CapabilityTier): readonly string[] {
  const { maxTools } = MODEL_CAPABILITY_TIERS[tier];
  if (tools.length <= maxTools) {
    return tools;
  }
  return tools.slice(0, maxTools);
}

/**
 * Composed profile resolution: Resolve -> Modify -> Cap.
 *
 * Returns the final tool name list and whether this is a "full" profile
 * (which should short-circuit filtering entirely).
 */
export function resolveProfile(input: ProfileResolutionInput): ResolvedProfile {
  const base = resolveBaseProfile(input.profile, input.tier);

  // "full" profile means no filtering
  if (base.length === 0) {
    return { toolNames: [], isFullProfile: true };
  }

  const modified = applyModifiers(base, input.include, input.exclude);

  // Apply tier cap only if a tier is specified
  const capped = input.tier !== undefined ? applyTierCap(modified, input.tier) : modified;

  return { toolNames: capped, isFullProfile: false };
}
