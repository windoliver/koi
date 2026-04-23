import { parseWrapperPrefix } from "./parse-prefix.js";
import type { EnvVar, UnwrapResult } from "./types.js";

// -i: ignore inherited env; -u: unset var (takes value); -C: chdir (takes value)
// -S: split-string — too complex to handle safely, refuse it
const ENV_BOOL = new Set(["i", "0"]);
const ENV_VALUE = new Set(["u", "C"]);
const ALLOW = { bool: ENV_BOOL, value: ENV_VALUE };

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Unwrap `env [OPTS] [NAME=VAL...] CMD ARGS...` → `[CMD, ...ARGS]`.
 * Env var assignments become `envVars` on the result.
 * Returns null on unknown flags (including -S), or when no CMD follows.
 */
export function unwrapEnv(argv: readonly string[]): UnwrapResult | null {
  if (argv[0] !== "env") return null;

  // Refuse -S (split-string): it reshapes argv in ways we can't safely model.
  for (const tok of argv) {
    if (tok === "-S" || tok.startsWith("--split-string")) return null;
  }

  const parsed = parseWrapperPrefix(argv, ALLOW);
  if (!parsed.ok) return null;

  // Remaining after flags: [NAME=VAL..., CMD, ARGS...]
  const rest = argv.slice(parsed.firstPositionalIndex);
  const envVars: EnvVar[] = [];
  let cmdStart = 0;
  for (const pos of rest) {
    if (ENV_VAR_NAME_RE.test(pos)) {
      const eq = pos.indexOf("=");
      envVars.push({ name: pos.slice(0, eq), value: pos.slice(eq + 1) });
      cmdStart += 1;
    } else {
      break;
    }
  }

  const cmdArgv = rest.slice(cmdStart);
  if (cmdArgv.length === 0) return null;

  return { argv: cmdArgv, envVars };
}
