/**
 * @koi/bash-ast — pure rule matcher.
 *
 * Matches a `BashRulePattern` from `@koi/core` against a parsed
 * `SimpleCommand`. Zero knowledge of verdicts or rule envelopes — the
 * permissions package (#1622, future) wraps this matcher inside its own
 * rule evaluator.
 *
 * Matching is positional and strict by default. See `BashRulePattern` for
 * the contract.
 */

import type { BashArgMatcher, BashRulePattern } from "@koi/core/bash-rule-pattern";
import type { SimpleCommand } from "./types.js";

/**
 * Returns `true` if the pattern matches the given parsed command.
 *
 *   - `argv0` is always checked against `cmd.argv[0]`.
 *   - If the pattern has both `args` and `argsPrefix` (a pattern bug),
 *     returns `false` conservatively rather than throwing.
 *   - If `args` is provided, `cmd.argv.length` must equal `args.length + 1`
 *     and each matcher must match its positional argv element.
 *   - If `argsPrefix` is provided, `cmd.argv.length` must be at least
 *     `argsPrefix.length + 1`; trailing argv elements are accepted.
 */
export function matchSimpleCommand(pattern: BashRulePattern, cmd: SimpleCommand): boolean {
  const firstArg = cmd.argv[0];
  if (firstArg === undefined) return false;

  if (!matchOne(pattern.argv0, firstArg)) return false;

  // Bug: providing both `args` and `argsPrefix` is a pattern construction
  // error. Fail closed — deny the match rather than guess intent.
  if (pattern.args !== undefined && pattern.argsPrefix !== undefined) {
    return false;
  }

  if (pattern.args !== undefined) {
    // Strict length match
    if (cmd.argv.length !== pattern.args.length + 1) return false;
    for (let i = 0; i < pattern.args.length; i++) {
      const matcher = pattern.args[i];
      const value = cmd.argv[i + 1];
      if (matcher === undefined || value === undefined) return false;
      if (!matchOne(matcher, value)) return false;
    }
    return true;
  }

  if (pattern.argsPrefix !== undefined) {
    if (cmd.argv.length < pattern.argsPrefix.length + 1) return false;
    for (let i = 0; i < pattern.argsPrefix.length; i++) {
      const matcher = pattern.argsPrefix[i];
      const value = cmd.argv[i + 1];
      if (matcher === undefined || value === undefined) return false;
      if (!matchOne(matcher, value)) return false;
    }
    return true;
  }

  // Neither `args` nor `argsPrefix` — argv tail is unconstrained.
  return true;
}

function matchOne(matcher: BashArgMatcher, value: string): boolean {
  if (typeof matcher === "string") return matcher === value;
  // SECURITY: regex flags `g` and `y` mutate `lastIndex` across calls, so
  // the same rule would alternate match/no-match on identical input. Strip
  // these stateful flags before testing by rebuilding the regex from its
  // source. Keeps `i`, `m`, `s`, `u`, `v` etc. which are safe.
  const { source, flags } = matcher;
  if (!flags.includes("g") && !flags.includes("y")) {
    return matcher.test(value);
  }
  const safeFlags = flags.replace(/[gy]/g, "");
  return new RegExp(source, safeFlags).test(value);
}
