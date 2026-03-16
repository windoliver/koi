/**
 * First-run tooltip state — tracks which onboarding hints have been dismissed.
 *
 * Persisted to `.koi/tui-state.json` so tooltips are shown only once.
 * Inspired by Codex CLI's `show_onboarding_tooltips` pattern.
 */

import { join } from "node:path";

/** Tooltip identifiers for first-run onboarding. */
export type TooltipId =
  | "welcome_preset_picker"
  | "agents_navigation"
  | "console_commands"
  | "forge_overview"
  | "data_sources_intro"
  | "zoom_hint"
  | "palette_hint";

/** Persisted TUI state. */
export interface TuiPersistentState {
  /** Tooltips that have been dismissed by the user. */
  readonly dismissedTooltips: readonly TooltipId[];
  /** Timestamp of first TUI launch. */
  readonly firstLaunchAt: number | undefined;
  /** Number of TUI sessions started. */
  readonly sessionCount: number;
}

const DEFAULT_STATE: TuiPersistentState = {
  dismissedTooltips: [],
  firstLaunchAt: undefined,
  sessionCount: 0,
};

const STATE_FILENAME = "tui-state.json";

/** Resolve the path to the TUI state file. */
function statePath(workspaceRoot: string): string {
  return join(workspaceRoot, ".koi", STATE_FILENAME);
}

/** Load persisted TUI state from disk. Returns defaults if file doesn't exist. */
export async function loadTuiState(workspaceRoot: string): Promise<TuiPersistentState> {
  try {
    const path = statePath(workspaceRoot);
    const file = Bun.file(path);
    if (!(await file.exists())) return DEFAULT_STATE;
    const raw: unknown = await file.json();
    if (typeof raw !== "object" || raw === null) return DEFAULT_STATE;
    const obj = raw as Record<string, unknown>;
    return {
      dismissedTooltips: Array.isArray(obj.dismissedTooltips)
        ? (obj.dismissedTooltips as TooltipId[])
        : [],
      firstLaunchAt: typeof obj.firstLaunchAt === "number" ? obj.firstLaunchAt : undefined,
      sessionCount: typeof obj.sessionCount === "number" ? obj.sessionCount : 0,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

/** Save persisted TUI state to disk. Creates .koi/ directory if needed. */
export async function saveTuiState(
  workspaceRoot: string,
  state: TuiPersistentState,
): Promise<void> {
  try {
    const path = statePath(workspaceRoot);
    const dir = join(workspaceRoot, ".koi");
    const { mkdirSync, existsSync } = await import("node:fs");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    await Bun.write(path, JSON.stringify(state, null, 2));
  } catch {
    // Best-effort persistence — don't block TUI on write failure
  }
}

/** Check whether a tooltip should be shown. */
export function shouldShowTooltip(state: TuiPersistentState, tooltipId: TooltipId): boolean {
  return !state.dismissedTooltips.includes(tooltipId);
}

/** Return new state with a tooltip marked as dismissed. */
export function dismissTooltip(
  state: TuiPersistentState,
  tooltipId: TooltipId,
): TuiPersistentState {
  if (state.dismissedTooltips.includes(tooltipId)) return state;
  return {
    ...state,
    dismissedTooltips: [...state.dismissedTooltips, tooltipId],
  };
}

/** Return new state with session count incremented and first launch recorded. */
export function recordSessionStart(state: TuiPersistentState): TuiPersistentState {
  return {
    ...state,
    firstLaunchAt: state.firstLaunchAt ?? Date.now(),
    sessionCount: state.sessionCount + 1,
  };
}
