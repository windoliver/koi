import { describe, expect, test } from "bun:test";
import { decideTuiGracefulAction, TUI_BG_EXIT_HINT } from "./tui-graceful-sigint.js";

describe("decideTuiGracefulAction", () => {
  test("active foreground stream → abort-active-stream (regardless of background)", () => {
    expect(
      decideTuiGracefulAction({
        hasActiveForegroundStream: true,
        hasActiveBackgroundTasks: false,
      }).kind,
    ).toBe("abort-active-stream");

    expect(
      decideTuiGracefulAction({
        hasActiveForegroundStream: true,
        hasActiveBackgroundTasks: true,
      }).kind,
    ).toBe("abort-active-stream");
  });

  test("idle foreground + live background → wait-for-bg-exit-tap (#1772 fix)", () => {
    // This is the regression target: previously, first Ctrl+C at idle
    // foreground ALWAYS triggered full shutdown — even when background
    // subprocesses were still running — tearing down the TUI on one tap.
    const result = decideTuiGracefulAction({
      hasActiveForegroundStream: false,
      hasActiveBackgroundTasks: true,
    });
    expect(result.kind).toBe("wait-for-bg-exit-tap");
    if (result.kind === "wait-for-bg-exit-tap") {
      expect(result.hint).toBe(TUI_BG_EXIT_HINT);
      expect(result.hint).toMatch(/Ctrl\+C again/);
    }
  });

  test("idle foreground + no background → shutdown (existing behavior preserved)", () => {
    // First Ctrl+C at an idle, empty TUI continues to quit immediately.
    // This is the conventional single-SIGINT-at-idle termination path.
    expect(
      decideTuiGracefulAction({
        hasActiveForegroundStream: false,
        hasActiveBackgroundTasks: false,
      }).kind,
    ).toBe("shutdown");
  });

  test("hint text names Ctrl+C specifically so the user knows what to press", () => {
    // Regression guard: the hint must stay actionable. If someone generalises
    // it to "press again" the user has no indication of which key.
    expect(TUI_BG_EXIT_HINT).toContain("Ctrl+C");
  });
});
