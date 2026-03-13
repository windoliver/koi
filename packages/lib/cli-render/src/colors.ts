/**
 * Minimal ANSI color wrappers — zero dependencies.
 *
 * Colors are computed once at module load based on terminal capabilities.
 * When colors are disabled (NO_COLOR, piped output), all functions return
 * the input string unchanged.
 */

import { isColorEnabled } from "./detect.js";

function wrap(open: string, close: string, enabled: boolean): (text: string) => string {
  return enabled ? (text) => `\x1b[${open}m${text}\x1b[${close}m` : (text) => text;
}

/** Create a set of color functions based on whether colors are enabled. */
export function createColors(enabled?: boolean): {
  readonly bold: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly red: (text: string) => string;
  readonly green: (text: string) => string;
  readonly yellow: (text: string) => string;
  readonly blue: (text: string) => string;
  readonly cyan: (text: string) => string;
  readonly gray: (text: string) => string;
} {
  const on = enabled ?? isColorEnabled();
  return {
    bold: wrap("1", "22", on),
    dim: wrap("2", "22", on),
    red: wrap("31", "39", on),
    green: wrap("32", "39", on),
    yellow: wrap("33", "39", on),
    blue: wrap("34", "39", on),
    cyan: wrap("36", "39", on),
    gray: wrap("90", "39", on),
  } as const;
}

// Module-level singleton — computed once at import time.
const _defaults = createColors(isColorEnabled(process.stderr as NodeJS.WriteStream));

/** Default color functions for stderr (where CLI status output goes). */
export const bold: (text: string) => string = _defaults.bold;
export const dim: (text: string) => string = _defaults.dim;
export const red: (text: string) => string = _defaults.red;
export const green: (text: string) => string = _defaults.green;
export const yellow: (text: string) => string = _defaults.yellow;
export const blue: (text: string) => string = _defaults.blue;
export const cyan: (text: string) => string = _defaults.cyan;
export const gray: (text: string) => string = _defaults.gray;
