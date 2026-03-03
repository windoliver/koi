/**
 * Configuration contracts — system-level config types and reactive store interface.
 *
 * KoiConfig defines the shape of system-wide runtime policy.
 * ConfigStore<T> provides a reactive get/subscribe interface for hot-reload.
 */

// ---------------------------------------------------------------------------
// Log level
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

export interface FeatureFlags {
  readonly [key: string]: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Section interfaces
// ---------------------------------------------------------------------------

export interface TelemetryConfig {
  readonly enabled: boolean;
  readonly endpoint?: string | undefined;
  readonly sampleRate?: number | undefined;
}

export interface LimitsConfig {
  readonly maxTurns: number;
  readonly maxDurationMs: number;
  readonly maxTokens: number;
}

export interface LoopDetectionConfigSection {
  readonly enabled: boolean;
  readonly windowSize: number;
  readonly threshold: number;
  readonly warningThreshold?: number | undefined;
}

export interface SpawnConfig {
  readonly maxDepth: number;
  readonly maxFanOut: number;
  readonly maxTotalProcesses: number;
  readonly spawnToolIds?: readonly string[] | undefined;
}

export interface ForgeConfigSection {
  readonly enabled: boolean;
  readonly maxForgeDepth: number;
  readonly maxForgesPerSession: number;
  readonly defaultScope: string;
  readonly defaultTrustTier: string;
}

export interface ModelRouterConfigSection {
  readonly strategy: string;
  readonly targets: readonly ModelTargetConfigEntry[];
}

export interface ModelTargetConfigEntry {
  readonly provider: string;
  readonly model: string;
  readonly weight?: number | undefined;
  readonly enabled?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// KoiConfig — top-level system config
// ---------------------------------------------------------------------------

export interface KoiConfig {
  readonly logLevel: LogLevel;
  readonly telemetry: TelemetryConfig;
  readonly limits: LimitsConfig;
  readonly loopDetection: LoopDetectionConfigSection;
  readonly spawn: SpawnConfig;
  readonly forge: ForgeConfigSection;
  readonly modelRouter: ModelRouterConfigSection;
  readonly features: FeatureFlags;
}

// ---------------------------------------------------------------------------
// ConfigStore — reactive read-only store
// ---------------------------------------------------------------------------

/** Callback invoked when the config value changes. */
export type ConfigListener<T> = (next: T, prev: T) => void;

/** Unsubscribe function returned by subscribe(). */
export type ConfigUnsubscribe = () => void;

/**
 * Read-only reactive config store.
 *
 * - `get()` is O(1), zero-allocation (returns a cached frozen reference).
 * - `subscribe()` fires synchronously on each update.
 */
export interface ConfigStore<T> {
  /** Returns the current config snapshot (shallow-frozen). */
  readonly get: () => T;
  /** Subscribes to config changes. Returns an unsubscribe function. */
  readonly subscribe: (listener: ConfigListener<T>) => ConfigUnsubscribe;
}

// ---------------------------------------------------------------------------
// ConfigSource — where a config value came from (for diagnostics)
// ---------------------------------------------------------------------------

export type ConfigSource =
  | { readonly kind: "default" }
  | { readonly kind: "file"; readonly filePath: string }
  | { readonly kind: "env"; readonly variable: string }
  | { readonly kind: "override" };
