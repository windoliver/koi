/**
 * Unicode spinner presets for TUI loading indicators.
 *
 * A single global `spinnerFrame` signal in MessageList drives all spinners in
 * sync. ToolCallBlock (running tool) and MessageRow (thinking indicator) both
 * read from DEFAULT_SPINNER so frame count and interval live in one place.
 * To change the active preset, point DEFAULT_SPINNER at a different entry.
 *
 * Frames must be single monowidth characters — grid-based multi-char animations
 * are intentionally out of scope to keep this file data-only.
 */

export interface Spinner {
  readonly frames: readonly string[];
  readonly intervalMs: number;
}

export type SpinnerName = "braille" | "dots" | "line" | "arc" | "circle";

export const SPINNERS: Readonly<Record<SpinnerName, Spinner>> = {
  braille: {
    frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    intervalMs: 80,
  },
  dots: {
    frames: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
    intervalMs: 80,
  },
  line: {
    frames: ["-", "\\", "|", "/"],
    intervalMs: 120,
  },
  arc: {
    frames: ["◜", "◠", "◝", "◞", "◡", "◟"],
    intervalMs: 100,
  },
  circle: {
    frames: ["◐", "◓", "◑", "◒"],
    intervalMs: 120,
  },
};

export const DEFAULT_SPINNER: Spinner = SPINNERS.braille;
