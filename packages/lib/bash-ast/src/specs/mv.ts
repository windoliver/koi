import { deriveBasenames } from "./derive-basenames.js";
import { matchesCommand } from "./dispatch-name.js";
import { type FlagAllowlist, parseFlags } from "./parse-flags.js";
import type { CommandSemantics, SpecResult } from "./types.js";

const MV_ALLOW = {
  bool: new Set(["f", "i", "n", "v", "T"]),
  value: new Set(["t"]),
} as const satisfies FlagAllowlist;

export function specMv(argv: readonly string[]): SpecResult {
  if (!matchesCommand("mv", argv)) {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: `specMv dispatched on argv[0]="${argv[0] ?? "<empty>"}", expected basename "mv"`,
    };
  }

  const parsed = parseFlags(argv, MV_ALLOW);
  if (!parsed.ok) {
    return { kind: "refused", cause: "parse-error", detail: parsed.detail };
  }

  const tValue = parsed.flags.get("t");
  const hasT = parsed.flags.has("T");

  if (hasT) {
    if (parsed.positionals.length !== 2) {
      return {
        kind: "refused",
        cause: "parse-error",
        detail: "mv -T requires exactly two positionals",
      };
    }
    const [src, dst] = parsed.positionals as readonly [string, string];
    return {
      kind: "complete",
      semantics: {
        reads: [],
        writes: [src, dst],
        network: [],
        envMutations: [],
      } satisfies CommandSemantics,
    };
  }

  if (typeof tValue === "string") {
    if (parsed.positionals.length === 0) {
      return {
        kind: "refused",
        cause: "parse-error",
        detail: "mv -t DIR requires at least one source",
      };
    }
    const derived = deriveBasenames(tValue, parsed.positionals);
    if (!derived.ok) {
      return { kind: "refused", cause: "parse-error", detail: derived.detail };
    }
    const writes = [...parsed.positionals, ...derived.paths];
    return {
      kind: "complete",
      semantics: { reads: [], writes, network: [], envMutations: [] } satisfies CommandSemantics,
    };
  }

  // Destination-last form
  if (parsed.positionals.length < 2) {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: "mv requires source(s) and a destination",
    };
  }
  const dst = parsed.positionals[parsed.positionals.length - 1];
  if (dst === undefined) {
    return { kind: "refused", cause: "parse-error", detail: "mv destination missing" };
  }
  const srcs = parsed.positionals.slice(0, -1);
  const derived = deriveBasenames(dst, srcs);
  if (!derived.ok) {
    return { kind: "refused", cause: "parse-error", detail: derived.detail };
  }
  const writes = [...srcs, dst, ...derived.paths];
  return {
    kind: "partial",
    semantics: { reads: [], writes, network: [], envMutations: [] } satisfies CommandSemantics,
    reason: "cp-mv-dest-may-be-directory",
  };
}
