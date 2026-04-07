/**
 * Pure state machine for auto-scroll behavior.
 *
 * The scrollbox in the TUI should follow new content while streaming,
 * but pause when the user scrolls up or selects text. After streaming
 * ends, a short settling period allows final reflow before resuming.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Auto-scroll modes */
export type ScrollMode = "following" | "paused" | "settling";

/** Reason why auto-scroll was paused */
export type PauseReason = "scroll" | "selection";

/** Auto-scroll state */
export interface AutoScrollState {
  readonly mode: ScrollMode;
  readonly pauseReason?: PauseReason | undefined;
  readonly settleUntil?: number | undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Initial state: following */
export const INITIAL_SCROLL_STATE: AutoScrollState = {
  mode: "following",
} as const;

/** Settling period in ms after streaming ends */
export const SETTLE_DURATION_MS = 300;

// ---------------------------------------------------------------------------
// Transition functions — all pure, return new state
// ---------------------------------------------------------------------------

/** User scrolled up -> pause auto-follow */
export function onScrollUp(state: AutoScrollState): AutoScrollState {
  if (state.mode === "paused" && state.pauseReason === "scroll") return state;
  return { mode: "paused", pauseReason: "scroll" };
}

/** User scrolled back to bottom -> resume following */
export function onScrollToBottom(state: AutoScrollState): AutoScrollState {
  if (state.mode === "following") return state;
  return { mode: "following" };
}

/** User started text selection -> pause */
export function onSelectionStart(state: AutoScrollState): AutoScrollState {
  if (state.mode === "paused" && state.pauseReason === "selection") return state;
  return { mode: "paused", pauseReason: "selection" };
}

/** User cleared text selection -> resume if paused for selection */
export function onSelectionEnd(state: AutoScrollState): AutoScrollState {
  if (state.mode === "paused" && state.pauseReason === "selection") {
    return { mode: "following" };
  }
  return state;
}

/** Streaming ended -> enter settling period */
export function onStreamEnd(_state: AutoScrollState, now: number): AutoScrollState {
  return { mode: "settling", settleUntil: now + SETTLE_DURATION_MS };
}

/** Settling timer expired -> resume following */
export function onSettleTimeout(_state: AutoScrollState): AutoScrollState {
  return { mode: "following" };
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/** Should the scrollbox follow new content? */
export function shouldFollow(state: AutoScrollState): boolean {
  return state.mode === "following" || state.mode === "settling";
}
