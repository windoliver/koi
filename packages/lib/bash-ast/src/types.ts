/**
 * @koi/bash-ast — public types.
 *
 * These types define the output shape of `classifyBashCommand()`. They are
 * re-exported from `index.ts`.
 *
 * `AstAnalysis` is a flat 3-variant discriminated union: `too-complex` and
 * `parse-unavailable` are expected outcomes that the caller must handle, not
 * errors. See `docs/L2/bash-ast.md` for the full design rationale.
 */

/**
 * An I/O redirect attached to a simple command.
 *
 * The `op` field is the operator token as it appears in the source (`>`,
 * `>>`, `<`, etc.). `fd` is the optional explicit file descriptor (e.g. `2`
 * for `2>&1`). `target` is the resolved target path or file descriptor as
 * a static literal; heredoc and other dynamic targets cause the containing
 * command to be classified `too-complex` rather than produce a redirect.
 */
export interface Redirect {
  readonly op: ">" | ">>" | "<" | "<<<" | ">&" | "<&" | "&>" | "&>>" | ">|";
  readonly target: string;
  readonly fd?: number;
}

/**
 * A single parsed shell command with argv-level detail.
 *
 * Only produced for commands the walker can fully resolve to a static
 * argv — anything involving variable expansion, command substitution, or
 * control flow results in `too-complex` at the analysis level.
 */
export interface SimpleCommand {
  /** argv[0] is the command name; argv[1..] are the resolved arguments. */
  readonly argv: readonly string[];
  /** Leading `VAR=val` assignments applied to this command only. */
  readonly envVars: readonly { readonly name: string; readonly value: string }[];
  /** Output/input redirects attached to this command. */
  readonly redirects: readonly Redirect[];
  /** Original source span for UI display and logging. */
  readonly text: string;
}

/**
 * The outcome of `classifyBashCommand()`.
 *
 *   - `simple` — the walker produced trustworthy argv for every command
 *     in the input. The caller may apply permission rules against each
 *     command's argv.
 *   - `too-complex` — the input contained grammar the walker cannot safely
 *     analyze (command substitution, variable expansion, control flow,
 *     function definitions, …). The caller must route to a fallback
 *     policy — currently, the `@koi/bash-security` regex classifier.
 *   - `parse-unavailable` — the parser itself could not run. `cause`
 *     discriminates the reason. **Callers MUST fail closed on this
 *     outcome** — do not fall through to a permissive path.
 */
export type AstAnalysis =
  | { readonly kind: "simple"; readonly commands: readonly SimpleCommand[] }
  | {
      readonly kind: "too-complex";
      readonly reason: string;
      readonly nodeType?: string;
    }
  | {
      readonly kind: "parse-unavailable";
      readonly cause: "not-initialized" | "timeout" | "over-length" | "panic";
    };
