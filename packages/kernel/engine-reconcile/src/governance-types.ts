/**
 * Governance configuration types — shared by reconcile controllers and the engine factory.
 */

// ---------------------------------------------------------------------------
// Governance configuration
// ---------------------------------------------------------------------------

export interface GovernanceConfig {
  readonly spawn: {
    readonly maxDepth: number;
    readonly maxFanOut: number;
  };
  readonly iteration: {
    readonly maxTurns: number;
    readonly maxTokens: number;
    readonly maxDurationMs: number;
  };
  readonly errorRate: {
    readonly windowMs: number;
    readonly threshold: number;
    /** Minimum tool calls in the window before enforcing threshold. Default: 3. */
    readonly minSampleSize?: number | undefined;
  };
  readonly cost: {
    /** Maximum cost in USD before violation. Set 0 to disable. */
    readonly maxCostUsd: number;
    /** Cost per input token in USD (e.g., 0.000003 for $3/1M tokens). */
    readonly costPerInputToken: number;
    /** Cost per output token in USD (e.g., 0.000015 for $15/1M tokens). */
    readonly costPerOutputToken: number;
  };
}

export const DEFAULT_GOVERNANCE_CONFIG: GovernanceConfig = Object.freeze({
  spawn: Object.freeze({
    maxDepth: 3,
    maxFanOut: 5,
  }),
  iteration: Object.freeze({
    maxTurns: 25,
    maxDurationMs: 300_000,
    maxTokens: 100_000,
  }),
  errorRate: Object.freeze({
    windowMs: 60_000,
    threshold: 0.5,
    minSampleSize: 3,
  }),
  cost: Object.freeze({
    maxCostUsd: 0, // disabled by default
    costPerInputToken: 0,
    costPerOutputToken: 0,
  }),
});

/**
 * Create a GovernanceConfig with defaults for omitted fields.
 * Deep merge: nested objects are merged individually, not replaced wholesale.
 */
export function createDefaultGovernanceConfig(
  overrides?: Partial<GovernanceConfig> | undefined,
): GovernanceConfig {
  if (overrides === undefined) return DEFAULT_GOVERNANCE_CONFIG;
  return {
    spawn:
      overrides.spawn !== undefined
        ? { ...DEFAULT_GOVERNANCE_CONFIG.spawn, ...overrides.spawn }
        : DEFAULT_GOVERNANCE_CONFIG.spawn,
    iteration:
      overrides.iteration !== undefined
        ? { ...DEFAULT_GOVERNANCE_CONFIG.iteration, ...overrides.iteration }
        : DEFAULT_GOVERNANCE_CONFIG.iteration,
    errorRate:
      overrides.errorRate !== undefined
        ? { ...DEFAULT_GOVERNANCE_CONFIG.errorRate, ...overrides.errorRate }
        : DEFAULT_GOVERNANCE_CONFIG.errorRate,
    cost:
      overrides.cost !== undefined
        ? { ...DEFAULT_GOVERNANCE_CONFIG.cost, ...overrides.cost }
        : DEFAULT_GOVERNANCE_CONFIG.cost,
  };
}

// ---------------------------------------------------------------------------
// Registry sync type (used by health-monitor)
// ---------------------------------------------------------------------------

/**
 * In-memory registry narrows all `T | Promise<T>` returns to sync `T`.
 * Omit base method signatures to prevent TypeScript union widening,
 * then re-declare with sync-only return types.
 */
export type InMemoryRegistry = Omit<
  import("@koi/core").AgentRegistry,
  "register" | "deregister" | "lookup" | "list" | "transition" | "patch"
> & {
  readonly register: (
    entry: import("@koi/core").RegistryEntry,
  ) => import("@koi/core").RegistryEntry;
  readonly deregister: (agentId: import("@koi/core").AgentId) => boolean;
  readonly lookup: (
    agentId: import("@koi/core").AgentId,
  ) => import("@koi/core").RegistryEntry | undefined;
  readonly list: (
    filter?: import("@koi/core").RegistryFilter,
    visibility?: import("@koi/core").VisibilityContext,
  ) => readonly import("@koi/core").RegistryEntry[];
  readonly transition: (
    agentId: import("@koi/core").AgentId,
    targetPhase: import("@koi/core").ProcessState,
    expectedGeneration: number,
    reason: import("@koi/core").TransitionReason,
  ) => import("@koi/core").Result<import("@koi/core").RegistryEntry, import("@koi/core").KoiError>;
  readonly patch: (
    agentId: import("@koi/core").AgentId,
    fields: import("@koi/core").PatchableRegistryFields,
  ) => import("@koi/core").Result<import("@koi/core").RegistryEntry, import("@koi/core").KoiError>;
  /** Manually trigger flush of any buffered heartbeats. */
  readonly flush: () => void;
  /** Return a read-only ProcessDescriptor snapshot for an agent. */
  readonly descriptor: (
    agentId: import("@koi/core").AgentId,
  ) => import("@koi/core").ProcessDescriptor | undefined;
};
