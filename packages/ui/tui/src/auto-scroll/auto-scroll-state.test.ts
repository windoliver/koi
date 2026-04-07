import { describe, expect, test } from "bun:test";
import type { AutoScrollState } from "./auto-scroll-state.js";
import {
  INITIAL_SCROLL_STATE,
  onScrollToBottom,
  onScrollUp,
  onSelectionEnd,
  onSelectionStart,
  onSettleTimeout,
  onStreamEnd,
  SETTLE_DURATION_MS,
  shouldFollow,
} from "./auto-scroll-state.js";

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe("INITIAL_SCROLL_STATE", () => {
  test("starts in following mode", () => {
    expect(INITIAL_SCROLL_STATE.mode).toBe("following");
    expect(INITIAL_SCROLL_STATE.pauseReason).toBeUndefined();
    expect(INITIAL_SCROLL_STATE.settleUntil).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// onScrollUp
// ---------------------------------------------------------------------------

describe("onScrollUp", () => {
  test("following -> paused(scroll)", () => {
    const next = onScrollUp(INITIAL_SCROLL_STATE);
    expect(next.mode).toBe("paused");
    expect(next.pauseReason).toBe("scroll");
  });

  test("idempotent: paused(scroll) stays paused(scroll)", () => {
    const paused: AutoScrollState = { mode: "paused", pauseReason: "scroll" };
    const next = onScrollUp(paused);
    expect(next).toBe(paused); // same reference — no new object
  });

  test("settling -> paused(scroll) (user can interrupt settling)", () => {
    const settling: AutoScrollState = {
      mode: "settling",
      settleUntil: Date.now() + 200,
    };
    const next = onScrollUp(settling);
    expect(next.mode).toBe("paused");
    expect(next.pauseReason).toBe("scroll");
  });
});

// ---------------------------------------------------------------------------
// onScrollToBottom
// ---------------------------------------------------------------------------

describe("onScrollToBottom", () => {
  test("paused(scroll) -> following", () => {
    const paused: AutoScrollState = { mode: "paused", pauseReason: "scroll" };
    const next = onScrollToBottom(paused);
    expect(next.mode).toBe("following");
    expect(next.pauseReason).toBeUndefined();
  });

  test("paused(selection) -> following", () => {
    const paused: AutoScrollState = {
      mode: "paused",
      pauseReason: "selection",
    };
    const next = onScrollToBottom(paused);
    expect(next.mode).toBe("following");
  });

  test("idempotent: following stays following", () => {
    const next = onScrollToBottom(INITIAL_SCROLL_STATE);
    expect(next).toBe(INITIAL_SCROLL_STATE); // same reference
  });
});

// ---------------------------------------------------------------------------
// onSelectionStart
// ---------------------------------------------------------------------------

describe("onSelectionStart", () => {
  test("following -> paused(selection)", () => {
    const next = onSelectionStart(INITIAL_SCROLL_STATE);
    expect(next.mode).toBe("paused");
    expect(next.pauseReason).toBe("selection");
  });

  test("idempotent: paused(selection) stays paused(selection)", () => {
    const paused: AutoScrollState = {
      mode: "paused",
      pauseReason: "selection",
    };
    const next = onSelectionStart(paused);
    expect(next).toBe(paused);
  });
});

// ---------------------------------------------------------------------------
// onSelectionEnd
// ---------------------------------------------------------------------------

describe("onSelectionEnd", () => {
  test("paused(selection) -> following", () => {
    const paused: AutoScrollState = {
      mode: "paused",
      pauseReason: "selection",
    };
    const next = onSelectionEnd(paused);
    expect(next.mode).toBe("following");
  });

  test("paused(scroll) unchanged — selection end does not clear scroll pause", () => {
    const paused: AutoScrollState = { mode: "paused", pauseReason: "scroll" };
    const next = onSelectionEnd(paused);
    expect(next).toBe(paused);
  });

  test("following unchanged", () => {
    const next = onSelectionEnd(INITIAL_SCROLL_STATE);
    expect(next).toBe(INITIAL_SCROLL_STATE);
  });
});

// ---------------------------------------------------------------------------
// onStreamEnd
// ---------------------------------------------------------------------------

describe("onStreamEnd", () => {
  test("any mode -> settling with settleUntil = now + SETTLE_DURATION_MS", () => {
    const now = 1000;
    const next = onStreamEnd(INITIAL_SCROLL_STATE, now);
    expect(next.mode).toBe("settling");
    expect(next.settleUntil).toBe(now + SETTLE_DURATION_MS);
  });

  test("paused -> settling", () => {
    const paused: AutoScrollState = { mode: "paused", pauseReason: "scroll" };
    const now = 5000;
    const next = onStreamEnd(paused, now);
    expect(next.mode).toBe("settling");
    expect(next.settleUntil).toBe(now + SETTLE_DURATION_MS);
  });
});

// ---------------------------------------------------------------------------
// onSettleTimeout
// ---------------------------------------------------------------------------

describe("onSettleTimeout", () => {
  test("settling -> following", () => {
    const settling: AutoScrollState = {
      mode: "settling",
      settleUntil: Date.now(),
    };
    const next = onSettleTimeout(settling);
    expect(next.mode).toBe("following");
    expect(next.settleUntil).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// shouldFollow
// ---------------------------------------------------------------------------

describe("shouldFollow", () => {
  test("returns true for following", () => {
    expect(shouldFollow(INITIAL_SCROLL_STATE)).toBe(true);
  });

  test("returns false for paused(scroll)", () => {
    expect(shouldFollow({ mode: "paused", pauseReason: "scroll" })).toBe(false);
  });

  test("returns false for paused(selection)", () => {
    expect(shouldFollow({ mode: "paused", pauseReason: "selection" })).toBe(false);
  });

  test("returns true for settling", () => {
    expect(shouldFollow({ mode: "settling", settleUntil: Date.now() + 300 })).toBe(true);
  });
});
