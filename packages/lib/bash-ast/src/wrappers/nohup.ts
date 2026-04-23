import type { UnwrapResult } from "./types.js";

/**
 * Unwrap `nohup CMD ARGS...` → `[CMD, ...ARGS]`.
 * Returns null when argv is bare `nohup` with no inner command.
 */
export function unwrapNohup(argv: readonly string[]): UnwrapResult | null {
  if (argv[0] !== "nohup" || argv.length < 2) return null;
  return { argv: argv.slice(1), envVars: [] };
}
