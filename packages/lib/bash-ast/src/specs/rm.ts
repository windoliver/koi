import { type FlagAllowlist, parseFlags } from "./parse-flags.js";
import type { CommandSemantics, SpecResult } from "./types.js";

const RM_ALLOW = {
  bool: new Set(["r", "R", "f", "i", "d", "v"]),
  value: new Set<string>(),
} as const satisfies FlagAllowlist;

const RECURSIVE_FLAGS = ["r", "R", "d"] as const;

export function specRm(argv: readonly string[]): SpecResult {
  if (argv[0] !== "rm") {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: `specRm dispatched on argv[0]="${argv[0] ?? "<empty>"}", expected "rm"`,
    };
  }

  const parsed = parseFlags(argv, RM_ALLOW);
  if (!parsed.ok) {
    return { kind: "refused", cause: "parse-error", detail: parsed.detail };
  }

  if (parsed.positionals.length === 0) {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: "rm requires at least one positional path",
    };
  }

  const semantics = {
    reads: [],
    writes: parsed.positionals,
    network: [],
    envMutations: [],
  } as const satisfies CommandSemantics;

  const recursive = RECURSIVE_FLAGS.some((f) => parsed.flags.has(f));
  if (recursive) {
    return { kind: "partial", semantics, reason: "recursive-subtree-root" };
  }
  return { kind: "complete", semantics };
}
