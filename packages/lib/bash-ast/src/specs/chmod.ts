import { matchesCommand } from "./dispatch-name.js";
import { type FlagAllowlist, parseFlags } from "./parse-flags.js";
import type { CommandSemantics, SpecResult } from "./types.js";

const CHMOD_ALLOW = {
  bool: new Set(["R", "v", "f"]),
  value: new Set<string>(),
} as const satisfies FlagAllowlist;

const CHMOD_BOOL_FLAGS = "Rvf";

/**
 * chmod symbolic modes can begin with `-` (e.g. `chmod -x file`,
 * `chmod -rwx dir`), which collide with the generic flag parser. This
 * regex matches POSIX symbolic-mode tokens that start with `-` and are
 * composed of mode chars only — the parser would otherwise refuse them
 * as unknown flags. Modes starting with `+`/`=` or alphanumeric (octal,
 * `u+x`, `a-w`, etc.) don't start with `-` and aren't affected.
 */
const SYMBOLIC_MODE_DASH_RE = /^-[rwxXstugoa,+\-=]+$/;

export function specChmod(argv: readonly string[]): SpecResult {
  if (!matchesCommand("chmod", argv)) {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: `specChmod dispatched on argv[0]="${argv[0] ?? "<empty>"}", expected basename "chmod"`,
    };
  }

  const preprocessed = insertCutoffBeforeSymbolicMode(argv);
  const parsed = parseFlags(preprocessed, CHMOD_ALLOW);
  if (!parsed.ok) {
    return { kind: "refused", cause: "parse-error", detail: parsed.detail };
  }

  if (parsed.positionals.length < 2) {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: "chmod requires a mode and at least one path",
    };
  }

  const writes = parsed.positionals.slice(1);
  const semantics = {
    reads: [],
    writes,
    network: [],
    envMutations: [],
  } as const satisfies CommandSemantics;

  if (parsed.flags.has("R")) {
    return { kind: "partial", semantics, reason: "recursive-subtree-root" };
  }
  return { kind: "complete", semantics };
}

/**
 * If we encounter a `-`-prefixed symbolic mode (e.g. `-x`) that is NOT a
 * known bool flag bundle, splice `--` before it so parseFlags treats it
 * as a positional rather than an unknown flag.
 */
function insertCutoffBeforeSymbolicMode(argv: readonly string[]): readonly string[] {
  for (let i = 1; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (tok === "--") return argv;
    if (!tok.startsWith("-") || tok.length === 1) return argv;
    const inner = tok.slice(1);
    const allBool = [...inner].every((c) => CHMOD_BOOL_FLAGS.includes(c));
    if (allBool) continue;
    if (SYMBOLIC_MODE_DASH_RE.test(tok)) {
      return [...argv.slice(0, i), "--", ...argv.slice(i)];
    }
    return argv;
  }
  return argv;
}
