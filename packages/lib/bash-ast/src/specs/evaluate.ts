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
 *     (`/bin/rm`, `/tmp/rm`, `./rm`) are REFUSED unless the consumer
 *     passes `options.verifiedBaseName` to assert that they have already
 *     verified the executable identity (canonicalized symlinks, vetted
 *     PATH/allowlist). The spec layer cannot distinguish `/bin/rm` from
 *     `/tmp/rm` (a wrapper) by basename alone — that trust check is the
 *     consumer's responsibility, and `verifiedBaseName` is the explicit
 *     opt-in so naively calling without verification fails loudly.
 *   - Resolved command name not in `registry` → `refused`, `cause: "parse-error"`.
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

export interface EvaluateOptions {
  /**
   * Bare command name to dispatch with, after the consumer has verified
   * `argv[0]`'s executable identity (canonicalized symlinks, allowlisted
   * trusted paths). When set, `evaluateBashCommand` uses this name for
   * registry lookup AND substitutes it into `argv[0]` for the spec call,
   * accepting walker output where `argv[0]` is path-qualified.
   *
   * When omitted, `evaluateBashCommand` requires `argv[0]` to already be
   * a bare command name; path-qualified `argv[0]` is refused so that
   * forgetting the verification step fails loudly.
   *
   * Passing `verifiedBaseName` is the consumer's explicit assertion that
   * the executable identity has been verified out of band; this package
   * does NOT perform that check.
   */
  readonly verifiedBaseName?: string;
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
  options?: EvaluateOptions,
): SpecResult {
  // Resolve the bare command name. If the consumer has verified the
  // executable identity, they pass `verifiedBaseName` and we accept any
  // `argv[0]` (typically path-qualified walker output). Otherwise we
  // require `argv[0]` to already be a bare command name — path-qualified
  // input fails loudly so callers can't accidentally bless wrappers.
  const head = cmd.argv[0];
  let resolvedName: string;
  if (options?.verifiedBaseName !== undefined) {
    resolvedName = options.verifiedBaseName;
  } else {
    if (head === undefined || head === "" || head.includes("/")) {
      return {
        kind: "refused",
        cause: "parse-error",
        detail: `evaluateBashCommand requires a bare command name; got "${head ?? "<empty>"}". Pass options.verifiedBaseName after consumer-side executable-identity verification.`,
      };
    }
    resolvedName = head;
  }
  const spec = registry.get(resolvedName);
  if (spec === undefined) {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: `no spec registered for command "${resolvedName}"`,
    };
  }

  // The spec's own dispatch check is bare-name only. When the consumer
  // passed a verifiedBaseName, swap argv[0] to that name so the spec
  // dispatch matches.
  const argvForSpec =
    options?.verifiedBaseName !== undefined && head !== resolvedName
      ? [resolvedName, ...cmd.argv.slice(1)]
      : cmd.argv;
  const raw = spec(argvForSpec);
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
