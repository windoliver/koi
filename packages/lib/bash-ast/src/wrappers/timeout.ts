import { parseWrapperPrefix } from "./parse-prefix.js";
import type { UnwrapResult } from "./types.js";

const TIMEOUT_BOOL = new Set(["preserve-status", "foreground"]);
const TIMEOUT_VALUE = new Set(["s", "k", "signal", "kill-after"]);
const ALLOW = { bool: TIMEOUT_BOOL, value: TIMEOUT_VALUE };

/**
 * Unwrap `timeout [OPTS] DURATION CMD ARGS...` → `[CMD, ...ARGS]`.
 * Returns null on unknown flags (refuse) or when DURATION / CMD are absent.
 */
export function unwrapTimeout(argv: readonly string[]): UnwrapResult | null {
  if (argv[0] !== "timeout") return null;

  const parsed = parseWrapperPrefix(argv, ALLOW);
  if (!parsed.ok) return null;

  // argv[firstPositionalIndex] = DURATION, argv[firstPositionalIndex+1] = CMD
  const cmdStart = parsed.firstPositionalIndex + 1;
  if (cmdStart >= argv.length) return null;

  return { argv: argv.slice(cmdStart), envVars: [] };
}
