/**
 * @koi/core/bash-rule-pattern — pattern for matching a parsed bash SimpleCommand.
 *
 * This is the L0 contract shared between:
 *   - `@koi/bash-ast` — extracts `SimpleCommand[]` from a raw command string
 *     and exports the `matchSimpleCommand()` matcher that consumes this pattern.
 *   - `@koi/middleware-permissions` (future, #1622) — wraps this pattern in the
 *     verdict/scope envelope and owns rule evaluation.
 *
 * Matching operates purely on the parsed `argv` array of a SimpleCommand.
 * The pattern intentionally does NOT carry semantic category metadata
 * (files-read/written/networked) — those would require per-command specs and
 * are out of scope for the phase-1 AST walker.
 *
 * L0 invariant: this file contains only types. No runtime code.
 */

/**
 * Match a single argv element.
 *
 *   - `string` — exact literal match (case-sensitive).
 *   - `RegExp` — pattern match. The matcher tests `regex.test(argv[i])`.
 *
 * To match a glob-like prefix, use an anchored regex (e.g. `/^--?\w+/` for
 * any flag). A literal `*` in a string is matched as the character `*`.
 */
export type BashArgMatcher = string | RegExp;

/**
 * Pattern matched against the `argv` of a parsed bash SimpleCommand.
 *
 * Matching semantics (pure):
 *
 *   1. `argv0` is matched against `argv[0]` (the command name).
 *   2. If neither `args` nor `argsPrefix` is provided, the rest of argv is
 *      not inspected — any arguments are accepted.
 *   3. If `args` is provided, match is strict: `argv.length` must equal
 *      `args.length + 1` and each `args[i]` must match `argv[i + 1]`.
 *   4. If `argsPrefix` is provided, match is a prefix: `argv.length` must be
 *      at least `argsPrefix.length + 1`, each `argsPrefix[i]` must match
 *      `argv[i + 1]`, and any trailing argv elements are accepted.
 *   5. `args` and `argsPrefix` are mutually exclusive. Providing both is a
 *      pattern bug; matcher implementations SHOULD treat this as "no match"
 *      rather than throw.
 *
 * The matcher implementation lives in `@koi/bash-ast`; this interface is
 * only the shape both sides agree on.
 */
export interface BashRulePattern {
  /** Match `argv[0]` (the command name). */
  readonly argv0: BashArgMatcher;
  /**
   * Strict positional match for `argv[1..]`. Mutually exclusive with
   * `argsPrefix`. When provided, argv length must match exactly.
   */
  readonly args?: readonly BashArgMatcher[];
  /**
   * Prefix positional match for `argv[1..]`. Mutually exclusive with `args`.
   * Trailing argv elements beyond `argsPrefix.length` are accepted.
   */
  readonly argsPrefix?: readonly BashArgMatcher[];
}
