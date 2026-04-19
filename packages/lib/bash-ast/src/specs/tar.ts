import { matchesCommand } from "./dispatch-name.js";
import type { FlagAllowlist } from "./parse-flags.js";
import { parseFlags } from "./parse-flags.js";
import type { CommandSemantics, SpecResult } from "./types.js";

const TAR_ALLOW = {
  bool: new Set(["x", "c", "t", "z", "j", "v"]),
  value: new Set(["f", "C"]),
} as const satisfies FlagAllowlist;

const MODE_FLAGS = ["x", "c", "t"] as const;

/**
 * For tar `-c` (create) mode: ordered scan of an already-bundle-expanded argv
 * that pairs each positional file operand with the most recent `-C DIR`
 * effective base. Multiple `-C` tokens may interleave between positionals.
 *
 *   tar -c -f out.tar a b           -> reads: [a, b]
 *   tar -c -C /etc -f out.tar a b   -> reads: [/etc/a, /etc/b]
 *   tar -c -C /etc passwd -C /var hosts -f out.tar -> reads: [/etc/passwd, /var/hosts]
 *
 * Honors `--` end-of-options (everything after is a positional even if it
 * starts with `-`). Absolute paths (starting with `/`) are emitted as-is —
 * tar reads them from the absolute location regardless of any active `-C`.
 */
function collectCreateReads(argv: readonly string[]): readonly string[] {
  const reads: string[] = [];
  let base: string | undefined;
  let cutoff = false;
  for (let i = 1; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === undefined) continue;

    if (cutoff) {
      reads.push(rebase(tok, base));
      continue;
    }

    if (tok === "--") {
      cutoff = true;
      continue;
    }

    if (tok === "-C" || tok === "--directory") {
      const next = argv[i + 1];
      if (next !== undefined) {
        base = next;
        i += 1;
      }
      continue;
    }
    if (tok.startsWith("-C") && tok.length > 2 && !tok.startsWith("--")) {
      base = tok.slice(2);
      continue;
    }
    if (tok.startsWith("--directory=")) {
      base = tok.slice("--directory=".length);
      continue;
    }

    // Skip -f FILE (archive) and other flags + their values
    if (tok === "-f" || tok === "--file") {
      i += 1;
      continue;
    }
    if (tok.startsWith("-f") && tok.length > 2 && !tok.startsWith("--")) continue;
    if (tok.startsWith("--file=")) continue;
    if (tok.startsWith("-")) continue;

    reads.push(rebase(tok, base));
  }
  return reads;
}

function rebase(operand: string, base: string | undefined): string {
  if (base === undefined) return operand;
  if (operand.startsWith("/")) return operand;
  return `${base}/${operand}`;
}

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
 * Tokens after `--` are passed through verbatim (they are positionals,
 * not flag bundles).
 */
function expandTarBundles(argv: readonly string[]): readonly string[] {
  const out: string[] = [];
  let cutoff = false;
  for (const tok of argv) {
    if (cutoff) {
      out.push(tok);
      continue;
    }
    if (tok === "--") {
      cutoff = true;
      out.push(tok);
      continue;
    }
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
  if (!matchesCommand("tar", argv)) {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: `specTar dispatched on argv[0]="${argv[0] ?? "<empty>"}", expected basename "tar"`,
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
    // -C DIR rebases following file operands relative to DIR; the rebase is
    // order-sensitive and may interleave with positionals, so we re-scan the
    // expanded argv directly to preserve ordering. parseFlags's flag map
    // would collapse repeated -C and lose positional ordering.
    const reads = collectCreateReads(expandTarBundles(argv));
    const semantics = {
      reads,
      writes: [archive],
      network: [],
      envMutations: [],
    } as const satisfies CommandSemantics;
    return { kind: "complete", semantics };
  }

  if (mode === "t") {
    // -t mode positionals are filename patterns matched inside the archive,
    // not local paths — `-C` is irrelevant to what `-t` reads from disk.
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
