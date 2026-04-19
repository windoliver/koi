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
 *   - `argv[0]` MUST be a bare command name. Path-qualified executables
 *     (`/bin/rm`, `/tmp/rm`, `./rm`) are REFUSED. The spec layer cannot
 *     distinguish `/bin/rm` from `/tmp/rm` (a wrapper) by basename alone,
 *     so emitting builtin semantics for an arbitrary path is unsafe.
 *     **Consumers MUST verify executable identity (canonicalize symlinks,
 *     resolve against a vetted PATH/allowlist) BEFORE calling this
 *     function and pass the bare name (or rewrite `argv[0]`).**
 *   - `argv[0]` not in `registry` → `refused`, `cause: "parse-error"`.
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
  // Bare command names only. Path-qualified `argv[0]` is refused so the
  // spec layer never silently authorizes an arbitrary executable as a
  // builtin. Consumers MUST canonicalize the executable identity and
  // pass the bare name (see docstring).
  const head = cmd.argv[0];
  if (head === undefined || head === "" || head.includes("/")) {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: `evaluateBashCommand requires a bare command name; got "${head ?? "<empty>"}". Consumer must canonicalize executable identity and pass the bare basename.`,
    };
  }
  const spec = registry.get(head);
  if (spec === undefined) {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: `no spec registered for command "${head}"`,
    };
  }

  const raw = spec(cmd.argv);
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
