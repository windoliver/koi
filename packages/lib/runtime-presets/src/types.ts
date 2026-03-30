/**
 * Typed preset definitions that control what `koi init` generates
 * and what `koi up` starts.
 */

// ---------------------------------------------------------------------------
// Preset IDs
// ---------------------------------------------------------------------------

/** The built-in runtime presets. */
export type PresetId = "local" | "demo" | "mesh" | "sqlite";

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

/** Thread store backend for context-arena conversation persistence. */
export type ThreadStoreBackend = "memory" | "sqlite" | "nexus";

/** ACE store backend for trajectory/playbook persistence. */
export type AceStoreBackend = "memory" | "sqlite" | "nexus";

/** Which L3 middleware stacks `koi up` should activate for this preset. */
export interface PresetStacks {
  readonly forge?: boolean;
  readonly contextArena?: boolean;
  readonly governance?: boolean;
  readonly toolStack?: boolean;
  readonly goalStack?: boolean;
  readonly retryStack?: boolean;
  readonly qualityGate?: boolean;
  readonly autoHarness?: boolean;
  readonly contextHub?: boolean;
  /** Backend for context-arena ThreadStore. Default: "memory". */
  readonly threadStoreBackend?: ThreadStoreBackend;
  /** Enable ACE (Adaptive Continuous Enhancement) middleware. */
  readonly ace?: boolean;
  /** Backend for ACE trajectory/playbook stores. Default: "memory". */
  readonly aceStoreBackend?: AceStoreBackend;
  /** Enable WASM code executor (execute_script tool). Zero infrastructure required. */
  readonly codeExecutor?: boolean;
  /** Enable sandbox stack (execute_code tool). Requires manifest `sandbox` config. */
  readonly sandboxStack?: boolean;
  /** Enable filesystem tools (fs_read, fs_write, fs_edit, fs_list, fs_search). */
  readonly filesystem?: boolean;
  /** Enable RLM stack (rlm_process tool for large-input virtualization). */
  readonly rlmStack?: boolean;
  /** Enable data source discovery and tools (query_datasource, probe_schema). */
  readonly dataSourceStack?: boolean;
  /** Enable Nexus-backed agent workspace (filesystem, scope enforcement, semantic search). */
  readonly workspaceStack?: boolean;
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
  /** L3 middleware stacks to activate. */
  readonly stacks: PresetStacks;
  /** Manifest YAML overrides applied by this preset. */
  readonly manifestOverrides: Readonly<Record<string, unknown>>;
}
