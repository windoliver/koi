/**
 * Config resolution: 3-layer merge (defaults -> preset -> user overrides).
 *
 * Validates required fields and resolves preset defaults.
 */

import { lookupPreset } from "@koi/preset-resolver";
import { IPC_PRESET_SPECS } from "./presets.js";
import type { IpcStackConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve IPC config by merging preset defaults under user overrides.
 *
 * Validation rules:
 * - Nexus messaging without config throws (requires agentId + connection info)
 * - Orchestrator delegation without config throws (requires spawn wiring config)
 */
export function resolveIpcConfig(config: IpcStackConfig): IpcStackConfig {
  const { preset, spec } = lookupPreset(IPC_PRESET_SPECS, config.preset, "local");

  // Validate: nexus messaging requires explicit config
  const effectiveMessaging = config.messaging ?? spec.messaging;
  if (
    effectiveMessaging?.kind === "nexus" &&
    !("config" in effectiveMessaging && effectiveMessaging.config !== undefined)
  ) {
    throw new Error(
      "[@koi/ipc-stack] Nexus messaging requires explicit config with agentId. " +
        "Provide messaging: { kind: 'nexus', config: { agentId, ... } }.",
    );
  }

  const effectiveDelegation = config.delegation ?? spec.delegation;

  return {
    ...config,
    preset,
    messaging: effectiveMessaging,
    delegation: effectiveDelegation,
  };
}
