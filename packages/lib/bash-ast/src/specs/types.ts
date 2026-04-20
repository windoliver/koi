/**
 * @koi/bash-ast/specs — public types for per-command semantic specs.
 *
 * See `docs/superpowers/specs/2026-04-18-bash-ast-command-specs-design.md`
 * for the full soundness contract. Summary:
 *   - `complete`  — argv-derived I/O accounting is complete; consumer
 *                   may use `semantics` as the sole input to argv-aware
 *                   `Read`/`Write`/`Network` rules.
 *   - `partial`   — populated fields are an under-approximation;
 *                   consumer MUST require an exact-argv `Run(...)`
 *                   co-rule for this argv. `reason` names the gap.
 *   - `refused`   — no semantics; consumer MUST use exact-argv
 *                   `Run(...)` rules and MUST NOT feed this argv into
 *                   any argv-aware rule. `cause` discriminates parse
 *                   failure from deliberate refusal; `detail` is for
 *                   audit logs.
 */

export interface CommandSemantics {
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly network: readonly NetworkAccess[];
  readonly envMutations: readonly string[];
}

export interface NetworkAccess {
  readonly kind: "http" | "ssh" | "ftp";
  /** Raw argv string — full URL for curl/wget, hostname for ssh/scp. */
  readonly target: string;
  /**
   * Extracted host for `Network(host)` rule matching. For URL-bearing
   * commands the spec parses the URL and stores `URL.host`. For ssh/scp
   * this would equal `target`, but ssh/scp always return `refused` in
   * this PR so no NetworkAccess is emitted from them.
   */
  readonly host: string;
}

export type SpecResult =
  | { readonly kind: "complete"; readonly semantics: CommandSemantics }
  | {
      readonly kind: "partial";
      readonly semantics: CommandSemantics;
      readonly reason: string;
    }
  | {
      readonly kind: "refused";
      readonly cause: "parse-error" | "unsupported-form";
      readonly detail: string;
    };

export type CommandSpec = (argv: readonly string[]) => SpecResult;
