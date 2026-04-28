import type { UnwrapResult } from "./types.js";

/**
 * Unwrap `time [-p] [--] CMD ARGS...` → `[CMD, ...ARGS]`.
 * Returns null for bare `time`, only `-p` flags, or unknown flags (refuse).
 */
export function unwrapTime(argv: readonly string[]): UnwrapResult | null {
  if (argv[0] !== "time") return null;

  let i = 1;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;
    if (tok === "--") {
      i += 1;
      break;
    }
    if (tok === "-p") {
      i += 1;
      continue;
    }
    if (tok.startsWith("-")) return null; // unknown flag — refuse
    break;
  }

  if (i >= argv.length) return null;
  return { argv: argv.slice(i), envVars: [] };
}
