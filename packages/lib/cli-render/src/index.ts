/**
 * @koi/cli-render — Terminal rendering utilities for CLI commands.
 *
 * Provides color detection, ANSI wrappers, spinners, structured output,
 * and phase timing. Zero external dependencies — uses platform APIs only.
 */

export {
  blue,
  bold,
  createColors,
  cyan,
  dim,
  gray,
  green,
  red,
  yellow,
} from "./colors.js";
export {
  type ColorLevel,
  detectColorLevel,
  detectStreamCapabilities,
  detectTerminal,
  isColorEnabled,
  type StreamCapabilities,
} from "./detect.js";
export {
  type CliOutput,
  type CliOutputOptions,
  createCliOutput,
} from "./output.js";
export { createSpinner, type Spinner } from "./spinner.js";

export { createTimer, type Timer, type TimingEntry } from "./timer.js";
