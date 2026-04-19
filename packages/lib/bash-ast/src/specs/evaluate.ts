import { lookupSpec } from "./registry.js";
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
 *   - argv[0] not in `registry` → `refused`, `cause: "parse-error"`,
 *     `detail` names the command.
 *   - Spec returns `refused` → propagated.
 *   - Spec returns `complete` or `partial`:
 *       - Merge redirect-derived writes/reads into `semantics`.
 *       - If `envVars` is non-empty, downgrade `complete` → `partial`
 *         with reason `"command-local-env-set"` (or extend the existing
 *         `partial` reason). Env values are not interpreted; the consumer
 *         must use a `Run(...)` co-rule for envful commands.
 *       - If redirects are present, downgrade `complete` → `partial`
 *         with reason `"shell-redirect-present"` (specs cannot validate
 *         redirect interactions like `>&fd` or process-substitution
 *         targets — those would already have been rejected by the walker
 *         as `too-complex`).
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

const READ_OPS: ReadonlySet<string> = new Set(["<", "<<<"]);
const WRITE_OPS: ReadonlySet<string> = new Set([">", ">>", "&>", "&>>", ">|"]);

export function evaluateBashCommand(
  cmd: EvaluateInput,
  registry: ReadonlyMap<string, CommandSpec>,
): SpecResult {
  const spec = lookupSpec(registry, cmd.argv[0]);
  if (spec === undefined) {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: `no spec registered for command "${cmd.argv[0] ?? "<empty>"}"`,
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
