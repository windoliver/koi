import { matchesCommand } from "./dispatch-name.js";
import { type FlagAllowlist, parseFlags } from "./parse-flags.js";
import type { CommandSemantics, SpecResult } from "./types.js";

const CHMOD_ALLOW = {
  bool: new Set(["R", "v", "f"]),
  value: new Set<string>(),
} as const satisfies FlagAllowlist;

export function specChmod(argv: readonly string[]): SpecResult {
  if (!matchesCommand("chmod", argv)) {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: `specChmod dispatched on argv[0]="${argv[0] ?? "<empty>"}", expected basename "chmod"`,
    };
  }

  const parsed = parseFlags(argv, CHMOD_ALLOW);
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
