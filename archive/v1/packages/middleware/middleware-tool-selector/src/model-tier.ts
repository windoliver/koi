/**
 * Model capability tier detection — maps model names to capability tiers.
 *
 * Used by autoScale to cap tool surface based on the running model's capacity.
 * Smaller models (Haiku, GPT-4o-mini) get fewer tools; larger models get more.
 */

/** Capability tier determines the maximum tool budget for a model. */
export type CapabilityTier = "minimal" | "standard" | "advanced" | "full";

/** Per-tier tool budget configuration. */
export const MODEL_CAPABILITY_TIERS: Readonly<
  Record<CapabilityTier, { readonly maxTools: number }>
> = {
  minimal: { maxTools: 5 },
  standard: { maxTools: 15 },
  advanced: { maxTools: 30 },
  full: { maxTools: Infinity },
} as const satisfies Record<CapabilityTier, { readonly maxTools: number }>;

/**
 * Built-in model name -> tier patterns. Checked via substring match,
 * ordered specific-to-general (e.g., "gpt-4o-mini" before "gpt-4o").
 */
const BUILTIN_MODEL_PATTERNS: readonly {
  readonly pattern: string;
  readonly tier: CapabilityTier;
}[] = [
  { pattern: "haiku", tier: "minimal" },
  { pattern: "gpt-4o-mini", tier: "minimal" },
  { pattern: "sonnet", tier: "standard" },
  { pattern: "gpt-4o", tier: "standard" },
  { pattern: "opus", tier: "advanced" },
  { pattern: "o3-mini", tier: "standard" },
  { pattern: "o3", tier: "advanced" },
  { pattern: "o1-mini", tier: "standard" },
  { pattern: "o1", tier: "advanced" },
];

const DEFAULT_TIER: CapabilityTier = "standard";

/**
 * Detects a model's capability tier from its name.
 *
 * Resolution order:
 * 1. Exact match in overrides map (if provided)
 * 2. First substring match in built-in patterns (ordered specific-to-general)
 * 3. Default: "standard"
 */
export function detectModelTier(
  modelName: string,
  overrides?: Readonly<Record<string, CapabilityTier>>,
): CapabilityTier {
  // Check overrides first
  if (overrides !== undefined) {
    const override = overrides[modelName];
    if (override !== undefined) {
      return override;
    }
  }

  // Substring match against built-in patterns
  const lower = modelName.toLowerCase();
  for (const entry of BUILTIN_MODEL_PATTERNS) {
    if (lower.includes(entry.pattern)) {
      return entry.tier;
    }
  }

  return DEFAULT_TIER;
}
