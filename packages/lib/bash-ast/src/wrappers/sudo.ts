import { parseWrapperPrefix } from "./parse-prefix.js";
import type { UnwrapResult } from "./types.js";

// Execution-mode-only boolean flags. Non-execution modes (-e/edit, -l/list,
// -v/validate) are intentionally excluded: encountering them causes
// parseWrapperPrefix to return { ok: false }, so unwrapSudo returns null and
// the command is left as-is (sudo stays argv[0], fail-closed).
//
//   sudo -e /etc/passwd  → file edit, NOT command execution — must NOT unwrap
//   sudo -l              → list permissions — must NOT unwrap
//   sudo -v              → validate credentials — must NOT unwrap
const SUDO_BOOL = new Set([
  "E",
  "H",
  "n",
  "S",
  "i",
  "k",
  "K",
  "b",
  "A",
  "s",
  "preserve-env",
  "set-home",
  "non-interactive",
  "stdin",
  "login",
  "reset-timestamp",
  "remove-timestamp",
  "background",
  "askpass",
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
  "context",
  "host",
  // "U" / "other-user" intentionally excluded: only meaningful with -l (list mode),
  // not an execution-mode option. Leave opaque (fail-closed).
]);
const ALLOW = { bool: SUDO_BOOL, value: SUDO_VALUE };

/**
 * Unwrap `sudo [OPTS] CMD ARGS...` → `[CMD, ...ARGS]`.
 *
 * Returns null (fail-closed, command left as-is) when:
 *   - A non-execution sudo mode is detected (`-e`/`--edit`, `-l`/`--list`,
 *     `-v`/`--validate`): these are not command-execution wrappers.
 *   - An unknown flag is present (ambiguous parse).
 *   - No CMD remains after parsing flags.
 */
export function unwrapSudo(argv: readonly string[]): UnwrapResult | null {
  if (argv[0] !== "sudo") return null;

  const parsed = parseWrapperPrefix(argv, ALLOW);
  if (!parsed.ok) return null;

  const cmdStart = parsed.firstPositionalIndex;
  if (cmdStart >= argv.length) return null;

  return { argv: argv.slice(cmdStart), envVars: [] };
}
