import { deriveBasenames } from "./derive-basenames.js";
import { type FlagAllowlist, parseFlags } from "./parse-flags.js";
import type { CommandSemantics, SpecResult } from "./types.js";

const CP_ALLOW = {
  bool: new Set(["r", "R", "f", "i", "p", "a", "v", "T"]),
  value: new Set(["t"]),
} as const satisfies FlagAllowlist;

const RECURSIVE_FLAGS = ["r", "R", "a"] as const;

export function specCp(argv: readonly string[]): SpecResult {
  if (argv[0] !== "cp") {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: `specCp dispatched on argv[0]="${argv[0] ?? "<empty>"}", expected "cp"`,
    };
  }

  const parsed = parseFlags(argv, CP_ALLOW);
  if (!parsed.ok) {
    return { kind: "refused", cause: "parse-error", detail: parsed.detail };
  }

  const recursive = RECURSIVE_FLAGS.some((f) => parsed.flags.has(f));
  const tValue = parsed.flags.get("t");
  const hasT = parsed.flags.has("T");

  if (hasT) {
    if (parsed.positionals.length !== 2) {
      return {
        kind: "refused",
        cause: "parse-error",
        detail: "cp -T requires exactly two positionals",
      };
    }
    const [src, dst] = parsed.positionals as readonly [string, string];
    const semantics = {
      reads: [src],
      writes: [dst],
      network: [],
      envMutations: [],
    } satisfies CommandSemantics;
    return recursive
      ? { kind: "partial", semantics, reason: "recursive-subtree-root" }
      : { kind: "complete", semantics };
  }

  if (typeof tValue === "string") {
    if (parsed.positionals.length === 0) {
      return {
        kind: "refused",
        cause: "parse-error",
        detail: "cp -t DIR requires at least one source",
      };
    }
    const derived = deriveBasenames(tValue, parsed.positionals);
    if (!derived.ok) {
      return { kind: "refused", cause: "parse-error", detail: derived.detail };
    }
    const semantics = {
      reads: [...parsed.positionals],
      writes: derived.paths,
      network: [],
      envMutations: [],
    } satisfies CommandSemantics;
    return recursive
      ? { kind: "partial", semantics, reason: "recursive-subtree-root" }
      : { kind: "complete", semantics };
  }

  // Destination-last form — always partial (dest may be a directory)
  if (parsed.positionals.length < 2) {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: "cp requires source(s) and a destination",
    };
  }
  const dst = parsed.positionals[parsed.positionals.length - 1];
  if (dst === undefined) {
    return { kind: "refused", cause: "parse-error", detail: "cp destination missing" };
  }
  const srcs = parsed.positionals.slice(0, -1);
  const derived = deriveBasenames(dst, srcs);
  if (!derived.ok) {
    return { kind: "refused", cause: "parse-error", detail: derived.detail };
  }
  const writes = [dst, ...derived.paths];
  const semantics = {
    reads: srcs,
    writes,
    network: [],
    envMutations: [],
  } satisfies CommandSemantics;
  const reason = recursive
    ? "recursive-subtree-root;cp-mv-dest-may-be-directory"
    : "cp-mv-dest-may-be-directory";
  return { kind: "partial", semantics, reason };
}
