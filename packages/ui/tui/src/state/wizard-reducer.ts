/**
 * Wizard reducer — handles setup flow actions.
 *
 * Returns partial state update or undefined if action not handled.
 */

import type { TuiAction, TuiState } from "./types.js";

/** Reduce wizard-related actions. Returns undefined if not handled. */
export function reduceWizard(state: TuiState, action: TuiAction): Partial<TuiState> | undefined {
  switch (action.kind) {
    case "set_presets":
      return { presets: action.presets };

    case "select_preset":
      return {
        selectedPresetIndex: Math.max(0, Math.min(action.index, state.presets.length - 1)),
      };

    case "set_active_preset_detail":
      return { activePresetDetail: action.detail };

    case "set_selected_preset_id":
      return { selectedPresetId: action.presetId };

    case "set_agent_name_input":
      return { agentNameInput: action.name };

    case "toggle_addon": {
      const current = state.selectedAddons;
      const next = new Set(current);
      if (next.has(action.addonId)) {
        next.delete(action.addonId);
      } else {
        next.add(action.addonId);
      }
      return { selectedAddons: next };
    }

    case "set_addon_focused_index":
      return { addonFocusedIndex: Math.max(0, action.index) };

    case "set_selected_model":
      return { selectedModel: action.model };

    case "set_selected_engine":
      return { selectedEngine: action.engine };

    case "set_selected_channels":
      return { selectedChannels: action.channels };

    case "append_phase_progress":
      return { phaseProgress: [...state.phaseProgress, action.progress] };

    case "set_setup_running":
      return { setupRunning: action.running };

    case "clear_phase_progress":
      return { phaseProgress: [], setupRunning: false };

    default:
      return undefined;
  }
}
