/**
 * @koi/runtime-presets — typed runtime preset definitions for koi init and koi up.
 */

export { ADDON_IDS, ADDONS } from "./addons.js";
export { getPreset, PRESET_IDS, resolveAddons, resolveRuntimePreset } from "./resolve.js";
export type {
  AddOn,
  NexusMode,
  NodeMode,
  PresetId,
  PresetServices,
  PresetStacks,
  RuntimePreset,
  TemporalMode,
} from "./types.js";
