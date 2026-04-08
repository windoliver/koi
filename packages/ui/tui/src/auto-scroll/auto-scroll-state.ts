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

/**
 * User started text selection -> pause, preserving any existing scroll pause.
 * If the user was already scroll-paused, selection end should restore scroll-pause
 * (not resume following), so we track both reasons.
 */
export function onSelectionStart(state: AutoScrollState): AutoScrollState {
  if (state.mode === "paused" && state.pauseReason === "selection") return state;
  // Preserve the fact that user was already scroll-paused before selection
  const wasScrollPaused = state.mode === "paused" && state.pauseReason === "scroll";
  return {
    mode: "paused",
    pauseReason: "selection",
    // Stash the prior scroll-pause so onSelectionEnd can restore it
    settleUntil: wasScrollPaused ? -1 : undefined,
  };
}

/**
 * User cleared text selection -> resume prior state.
 * If the user was scroll-paused before selecting, restore scroll-pause
 * instead of jumping to following. settleUntil === -1 is the sentinel
 * for "was scroll-paused before selection started".
 */
export function onSelectionEnd(state: AutoScrollState): AutoScrollState {
  if (state.mode !== "paused" || state.pauseReason !== "selection") return state;
  // Restore scroll-pause if it was active before selection
  if (state.settleUntil === -1) {
    return { mode: "paused", pauseReason: "scroll" };
  }
  return { mode: "following" };
}

/**
 * Streaming ended -> enter settling period, BUT only if currently following.
 * A user who explicitly paused (scroll-up or text selection) should NOT be
 * yanked back to the live tail just because the stream completed.
 */
export function onStreamEnd(state: AutoScrollState, now: number): AutoScrollState {
  // Preserve explicit user pause — don't override scroll/selection pauses
  if (state.mode === "paused") return state;
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
