import { posixBasename } from "./posix-basename.js";
import type { CommandSemantics, CommandSpec, SpecResult } from "./types.js";

/**
 * Higher-level entry point that takes the walker's `SimpleCommand` shape
 * (argv + envVars + redirects + text) and returns a `SpecResult` that
 * accounts for redirect-derived writes/reads and the presence of
 * command-local env vars.
 *
 * This is the **blessed public API for permission consumers.** Calling a
 * raw `spec*(argv)` function on walker output would silently drop:
 *   - shell redirects (`> /tmp/out` writes a file the spec never sees);
 *   - command-local env (`HTTPS_PROXY=…` changes egress; `HOME=…`
 *     changes config/key paths for ssh/scp/curl);
 * so any `complete` result from the raw spec would be unsound.
 *
 * Behavior:
 *   - `argv[0]` is normalized to its POSIX basename before registry
 *     lookup, so both `rm` and `/bin/rm` dispatch to specRm. **The
 *     consumer MUST verify executable identity (canonicalize symlinks,
 *     allowlist trusted paths) BEFORE calling this function** — the
 *     basename strip alone does not distinguish `/bin/rm` from
 *     `/tmp/rm` (a wrapper).
 *   - Basename not in `registry` → `refused`, `cause: "parse-error"`.
 *   - Spec returns `refused` → propagated.
 *   - Spec returns `complete` or `partial`:
 *       - Merge **modeled** redirects (`>`, `>>`, `<`, `&>`, `&>>`,
 *         `>|`) into `semantics.writes` / `semantics.reads`. Here-strings
 *         (`<<<`) are inline stdin data, NOT a path — they are NOT added
 *         to reads.
 *       - If `envVars` is non-empty, downgrade `complete` → `partial`
 *         with reason `"command-local-env-set"`.
 *       - If FD-duplication or other unmodeled redirect ops are present,
 *         downgrade with reason `"shell-redirect-fd-or-unknown-op"`.
 *
 * Returned `complete` results from `evaluateBashCommand` are therefore
 * authoritative across argv + redirects + env. Returned `partial` results
 * still require a `Run(...)` co-rule (per the existing soundness contract).
 */
export interface EvaluateInput {
  readonly argv: readonly string[];
  readonly envVars: readonly { readonly name: string; readonly value: string }[];
  readonly redirects: readonly Redirect[];
}

export interface Redirect {
  readonly op: string;
  readonly target: string;
  readonly fd?: number;
}

// `<` reads a file path; `<<<` is a here-string (inline stdin data,
// not a path), so it does NOT contribute to reads.
const READ_OPS: ReadonlySet<string> = new Set(["<"]);
const WRITE_OPS: ReadonlySet<string> = new Set([">", ">>", "&>", "&>>", ">|"]);

export function evaluateBashCommand(
  cmd: EvaluateInput,
  registry: ReadonlyMap<string, CommandSpec>,
): SpecResult {
  // The consumer is responsible for verifying executable identity
  // (canonicalizing symlinks, allowlisting trusted paths) BEFORE calling
  // this function. After that gate, we accept path-qualified `argv[0]`
  // by stripping to its POSIX basename for registry lookup. Both `rm`
  // and `/bin/rm` (post-canonicalization) dispatch to specRm.
  const head = cmd.argv[0];
  const baseName = head === undefined ? undefined : commandBasename(head);
  const spec = baseName === undefined ? undefined : registry.get(baseName);
  if (spec === undefined) {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: `no spec registered for command "${head ?? "<empty>"}"`,
    };
  }
  // Pass the spec the canonicalized argv (basename in argv[0]) so the
  // spec's own dispatch check (which is bare-name only) sees a match.
  const normalizedArgv = baseName === head ? cmd.argv : [baseName, ...cmd.argv.slice(1)];

  const raw = spec(normalizedArgv);
  if (raw.kind === "refused") return raw;

  const redirectReads: string[] = [];
  const redirectWrites: string[] = [];
  let redirectUnknown = false;
  for (const r of cmd.redirects) {
    if (READ_OPS.has(r.op)) {
      redirectReads.push(r.target);
    } else if (WRITE_OPS.has(r.op)) {
      redirectWrites.push(r.target);
    } else {
      // FD-duplication operators (>&, <&) and anything we don't model.
      redirectUnknown = true;
    }
  }

  const merged: CommandSemantics = {
    reads: [...raw.semantics.reads, ...redirectReads],
    writes: [...raw.semantics.writes, ...redirectWrites],
    network: raw.semantics.network,
    envMutations: raw.semantics.envMutations,
  };

  const reasons: string[] = [];
  if (raw.kind === "partial") reasons.push(raw.reason);
  if (cmd.envVars.length > 0) reasons.push("command-local-env-set");
  if (redirectUnknown) reasons.push("shell-redirect-fd-or-unknown-op");

  if (reasons.length > 0) {
    return { kind: "partial", semantics: merged, reason: reasons.join(";") };
  }
  return { kind: "complete", semantics: merged };
}

/**
 * POSIX basename of `argv0` for registry lookup. Returns `undefined` if
 * the input has no usable basename (`""`, `/`, etc.). The consumer is
 * required to verify executable identity (canonicalize symlinks,
 * allowlist trusted paths) BEFORE calling `evaluateBashCommand`; this
 * helper just strips the path so lookup can match the registry's bare
 * command keys.
 */
function commandBasename(argv0: string): string | undefined {
  if (argv0.length === 0) return undefined;
  if (!argv0.includes("/")) return argv0;
  const base = posixBasename(argv0);
  return base.ok ? base.value : undefined;
}
