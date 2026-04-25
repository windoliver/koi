/**
 * @koi/bash-classifier — public types.
 *
 * Categories correspond to *structural* command shape (what the command
 * mechanically does), not to argument content like URLs, hostnames, or
 * file paths. Dangerous-target detection belongs in sibling packages.
 */

/** Structural danger category. */
export type Category =
  | "process-spawn"
  | "file-destructive"
  | "network-exfil"
  | "code-exec"
  | "module-load"
  | "privilege-escalation"
  | "persistence";

/** Severity ordering: low < medium < high < critical. */
export type Severity = "low" | "medium" | "high" | "critical";

/**
 * A single dangerous-pattern entry. Shipped as frozen data so permission
 * gates and UI hint surfaces share the same source of truth.
 *
 * `regex` must be stateless (no `g`/`y` flags) so concurrent `test()` calls
 * do not interfere through `lastIndex`.
 */
export interface DangerousPattern {
  readonly id: string;
  readonly regex: RegExp;
  readonly category: Category;
  readonly severity: Severity;
  readonly message: string;
  /**
   * When set, the pattern only fires if the command's first-token
   * basename is in this set. Prevents false positives where the
   * dangerous word appears inside a quoted argument (e.g.
   * `echo "sudo"` must NOT match the `sudo` pattern).
   *
   * Patterns without `commandPrefixes` still match on raw string —
   * use this for structural shapes (fork bomb, `curl | sh`,
   * redirections) that are not identified by a single command name.
   */
  readonly commandPrefixes?: readonly string[];
}

/** Output of `classifyCommand`. */
export interface ClassifyResult {
  readonly prefix: string;
  readonly matchedPatterns: readonly DangerousPattern[];
  readonly severity: Severity | null;
}
