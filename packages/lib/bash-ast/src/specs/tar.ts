import type { FlagAllowlist } from "./parse-flags.js";
import { parseFlags } from "./parse-flags.js";
import type { CommandSemantics, SpecResult } from "./types.js";

const TAR_ALLOW = {
  bool: new Set(["x", "c", "t", "z", "j", "v"]),
  value: new Set(["f", "C"]),
} as const satisfies FlagAllowlist;

const MODE_FLAGS = ["x", "c", "t"] as const;

/**
 * Tar's idiomatic bundled forms mix bool mode flags with the `-f`/`-C`
 * value flags. The bundle has shape `-<bools><valueFlag><attachedValue?>`:
 * everything before the first value-flag char is bool flags, the value-flag
 * char itself takes a value, and any chars after it are that value attached.
 *
 *   `-cf`         → `-c -f`              (no attached value; -f consumes next argv)
 *   `-zcf`        → `-zc -f`
 *   `-cfout.tar`  → `-c -fout.tar`       (attached value form)
 *   `-fout.tar`   → `-fout.tar`          (already attached; passthrough)
 *   `-CDIR`       → `-CDIR`              (passthrough)
 *
 * If no value flag is present, the bundle is left untouched for parseFlags
 * to handle via its normal bool-bundle path.
 */
function expandTarBundles(argv: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const tok of argv) {
    if (
      !tok.startsWith("-") ||
      tok.startsWith("--") ||
      tok.length <= 2 ||
      (!tok.includes("f") && !tok.includes("C"))
    ) {
      out.push(tok);
      continue;
    }
    const chars = tok.slice(1);
    const valueIdx = [...chars].findIndex((c) => c === "f" || c === "C");
    if (valueIdx === -1) {
      out.push(tok);
      continue;
    }
    const boolChars = chars.slice(0, valueIdx);
    const tail = chars.slice(valueIdx);
    if (boolChars.length > 0) out.push(`-${boolChars}`);
    out.push(`-${tail}`);
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
