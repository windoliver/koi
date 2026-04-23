import { parseWrapperPrefix } from "./parse-prefix.js";
import type { UnwrapResult } from "./types.js";

const STDBUF_VALUE = new Set(["i", "o", "e", "input", "output", "error"]);
const ALLOW = { bool: new Set<string>(), value: STDBUF_VALUE };

/**
 * Unwrap `stdbuf [-i M] [-o M] [-e M] CMD ARGS...` → `[CMD, ...ARGS]`.
 * Returns null on unknown flags (refuse) or when no CMD remains after flags.
 */
export function unwrapStdbuf(argv: readonly string[]): UnwrapResult | null {
  if (argv[0] !== "stdbuf") return null;

  const parsed = parseWrapperPrefix(argv, ALLOW);
  if (!parsed.ok) return null;

  const cmdStart = parsed.firstPositionalIndex;
  if (cmdStart >= argv.length) return null;

  return { argv: argv.slice(cmdStart), envVars: [] };
}
