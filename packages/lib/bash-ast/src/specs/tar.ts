import type { FlagAllowlist } from "./parse-flags.js";
import { parseFlags } from "./parse-flags.js";
import type { CommandSemantics, SpecResult } from "./types.js";

const TAR_ALLOW = {
  bool: new Set(["x", "c", "t", "z", "j", "v"]),
  value: new Set(["f", "C"]),
} as const satisfies FlagAllowlist;

const MODE_FLAGS = ["x", "c", "t"] as const;

/**
 * Tar's idiomatic bundled forms (`-cf`, `-tf`, `-xf`, `-zcf`, `-jxf`, ...)
 * mix bool mode flags with the `-f` value flag. Pre-expand any short-flag
 * bundle that contains `f` (or `C`) into separate tokens so parseFlags can
 * handle the value extraction normally.
 *
 * `-cf`  → `-c -f`
 * `-zcf` → `-zc -f`
 * `-cfC` → `-c -f -C`
 */
function expandTarBundles(argv: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const tok of argv) {
    if (
      tok.startsWith("-") &&
      !tok.startsWith("--") &&
      tok.length > 2 &&
      (tok.includes("f") || tok.includes("C"))
    ) {
      const chars = tok.slice(1);
      const valueChars = chars.split("").filter((c) => c === "f" || c === "C");
      const boolChars = chars.split("").filter((c) => c !== "f" && c !== "C");
      if (boolChars.length > 0) out.push(`-${boolChars.join("")}`);
      for (const c of valueChars) out.push(`-${c}`);
    } else {
      out.push(tok);
    }
  }
  return out;
}

export function specTar(argv: readonly string[]): SpecResult {
  if (argv[0] !== "tar") {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: `specTar dispatched on argv[0]="${argv[0] ?? "<empty>"}", expected "tar"`,
    };
  }

  const parsed = parseFlags(expandTarBundles(argv), TAR_ALLOW);
  if (!parsed.ok) {
    return { kind: "refused", cause: "parse-error", detail: parsed.detail };
  }

  const modes = MODE_FLAGS.filter((m) => parsed.flags.has(m));
  if (modes.length !== 1) {
    const detail =
      modes.length === 0
        ? "tar requires exactly one mode flag (-x, -c, or -t)"
        : `tar received conflicting mode flags: ${modes.map((m) => `-${m}`).join(", ")}`;
    return {
      kind: "refused",
      cause: "parse-error",
      detail,
    };
  }

  const archive = parsed.flags.get("f");
  if (typeof archive !== "string") {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: "tar requires -f FILE (stdin form not supported by this spec)",
    };
  }

  const mode = modes[0];

  if (mode === "c") {
    const semantics = {
      reads: parsed.positionals,
      writes: [archive],
      network: [],
      envMutations: [],
    } as const satisfies CommandSemantics;
    return { kind: "complete", semantics };
  }

  if (mode === "t") {
    const semantics = {
      reads: [archive],
      writes: [],
      network: [],
      envMutations: [],
    } as const satisfies CommandSemantics;
    return { kind: "complete", semantics };
  }

  // mode === "x"
  const semantics = {
    reads: [archive],
    writes: [],
    network: [],
    envMutations: [],
  } as const satisfies CommandSemantics;
  return { kind: "partial", semantics, reason: "tar-extract-targets-in-archive" };
}
