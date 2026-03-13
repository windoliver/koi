/**
 * Typed preset definitions that control what `koi init` generates
 * and what `koi up` starts.
 */

// ---------------------------------------------------------------------------
// Preset IDs
// ---------------------------------------------------------------------------

/** The three built-in runtime presets. */
export type PresetId = "local" | "demo" | "mesh";

// ---------------------------------------------------------------------------
// Add-on definitions
// ---------------------------------------------------------------------------

/** An optional add-on that extends a preset's capabilities. */
export interface AddOn {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Package name to add as a dependency. */
  readonly packageName: string;
  /** Channel name to add to manifest (undefined for non-channel add-ons). */
  readonly channelName: string | undefined;
  /** Environment variables required by this add-on. */
  readonly envKeys: readonly { readonly key: string; readonly label: string }[];
}

// ---------------------------------------------------------------------------
// Runtime preset
// ---------------------------------------------------------------------------

/** Temporal auto-configuration mode. */
export type TemporalMode = "auto" | "manual" | "disabled";

/** Node execution mode for gateway/node presets. */
export type NodeMode = "full" | "thin" | "disabled";

/** Nexus embed profile for security model. */
export type NexusMode = "embed-lite" | "embed-auth" | "remote";

/** Which services `koi up` should start for this preset. */
export interface PresetServices {
  readonly adminApi: boolean;
  readonly tui: boolean;
  readonly nexus: boolean;
  readonly temporal: TemporalMode;
  readonly gateway: boolean;
  readonly node: NodeMode;
}

/** A complete runtime preset definition. */
export interface RuntimePreset {
  readonly id: PresetId;
  readonly description: string;
  /** Nexus embed security model. */
  readonly nexusMode: NexusMode;
  /** Services that `koi up` starts for this preset. */
  readonly services: PresetServices;
  /** Default channel package names (e.g. "@koi/channel-cli"). */
  readonly defaultChannels: readonly string[];
  /** Default add-on IDs included by this preset. */
  readonly defaultAddons: readonly string[];
  /** Demo pack ID to auto-seed (undefined for non-demo presets). */
  readonly demoPack: string | undefined;
  /** Manifest YAML overrides applied by this preset. */
  readonly manifestOverrides: Readonly<Record<string, unknown>>;
}
