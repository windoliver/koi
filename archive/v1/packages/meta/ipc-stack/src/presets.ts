/**
 * IPC deployment presets: local, cloud, hybrid.
 *
 * Each preset provides sensible defaults for messaging and delegation.
 * User overrides always win. Workspace, scratchpad, and federation
 * are opt-in (not preset-defaulted) since they require user-specific config.
 */

import type { IpcPreset, IpcPresetSpec } from "./types.js";

// ---------------------------------------------------------------------------
// Preset definitions (deeply frozen)
// ---------------------------------------------------------------------------

const LOCAL: IpcPresetSpec = Object.freeze({
  messaging: Object.freeze({ kind: "local" as const }),
  delegation: Object.freeze({ kind: "task-spawn" as const }),
});

const CLOUD: IpcPresetSpec = Object.freeze({
  messaging: Object.freeze({ kind: "nexus" as const }),
  delegation: Object.freeze({ kind: "task-spawn" as const }),
});

const HYBRID: IpcPresetSpec = Object.freeze({
  messaging: Object.freeze({ kind: "local" as const }),
  delegation: Object.freeze({ kind: "task-spawn" as const }),
});

// ---------------------------------------------------------------------------
// Exported registry
// ---------------------------------------------------------------------------

/** Frozen registry of IPC preset specs, keyed by preset name. */
export const IPC_PRESET_SPECS: Readonly<Record<IpcPreset, IpcPresetSpec>> = Object.freeze({
  local: LOCAL,
  cloud: CLOUD,
  hybrid: HYBRID,
});
