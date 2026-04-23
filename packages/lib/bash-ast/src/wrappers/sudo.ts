import { parseWrapperPrefix } from "./parse-prefix.js";
import type { UnwrapResult } from "./types.js";

const SUDO_BOOL = new Set([
  "E",
  "H",
  "n",
  "S",
  "i",
  "k",
  "K",
  "l",
  "v",
  "b",
  "A",
  "e",
  "s",
  "preserve-env",
  "set-home",
  "non-interactive",
  "stdin",
  "login",
  "reset-timestamp",
  "remove-timestamp",
  "list",
  "validate",
  "background",
  "askpass",
  "edit",
  "shell",
]);
const SUDO_VALUE = new Set([
  "u",
  "g",
  "r",
  "t",
  "C",
  "D",
  "T",
  "p",
  "U",
  "c",
  "h",
  "user",
  "group",
  "role",
  "type",
  "close-from",
  "chdir",
  "command-timeout",
  "prompt",
  "other-user",
  "context",
  "host",
]);
const ALLOW = { bool: SUDO_BOOL, value: SUDO_VALUE };

/**
 * Unwrap `sudo [OPTS] CMD ARGS...` → `[CMD, ...ARGS]`.
 * Returns null on unknown flags (refuse) or when no CMD remains.
 */
export function unwrapSudo(argv: readonly string[]): UnwrapResult | null {
  if (argv[0] !== "sudo") return null;

  const parsed = parseWrapperPrefix(argv, ALLOW);
  if (!parsed.ok) return null;

  const cmdStart = parsed.firstPositionalIndex;
  if (cmdStart >= argv.length) return null;

  return { argv: argv.slice(cmdStart), envVars: [] };
}
