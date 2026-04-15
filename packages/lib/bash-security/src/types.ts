/**
 * @koi/bash-security — shared types for bash security classifiers.
 *
 * BashPolicy, ClassificationResult, ThreatCategory, and ThreatPattern
 * are defined here and used by all three classifier modules.
 */

/** MITRE ATT&CK-aligned threat categories. */
export type ThreatCategory =
  | "path-traversal"
  | "injection"
  | "reverse-shell"
  | "privilege-escalation"
  | "recon"
  | "persistence"
  | "data-exfiltration"
  | "destructive";

/** A single compiled pattern entry with category and diagnostic reason. */
export interface ThreatPattern {
  readonly regex: RegExp;
  readonly category: ThreatCategory;
  readonly reason: string;
}

/**
 * Rich result from a classifier function.
 *
 * On block: includes the matched pattern source, human-readable reason,
 * and ATT&CK-aligned threat category for logging and user-facing messages.
 */
export type ClassificationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly pattern: string;
      readonly category: ThreatCategory;
    };

/**
 * Configuration for bash execution security policy.
 *
 * Security model: configurable allowlist (primary gate) + mandatory denylist
 * (secondary gate). The denylist always runs, even for allowlisted commands.
 */
export interface BashPolicy {
  /**
   * Optional allowlist of command prefixes. When set, a command must match
   * at least one prefix to proceed to denylist checks.
   *
   * Use a trailing space to require arguments: `"git "` matches `git status`
   * but not bare `git`. Without a trailing space, `"git"` matches any command
   * starting with those characters.
   *
   * @example ["git ", "ls", "cat ", "bun ", "echo "]
   */
  readonly allowlist?: readonly string[];

  /**
   * Maximum bytes to collect from stdout + stderr combined.
   * Output exceeding this limit is truncated and annotated.
   * @default 1_048_576 (1 MB)
   */
  readonly maxOutputBytes?: number;

  /**
   * Default execution timeout in milliseconds.
   * Can be overridden per-invocation via the tool's `timeoutMs` argument.
   * @default 30_000 (30 seconds)
   */
  readonly defaultTimeoutMs?: number;
}

/** Default policy: no allowlist, 1 MB output cap, 30-second timeout. */
export const DEFAULT_BASH_POLICY: BashPolicy = {
  maxOutputBytes: 1_048_576,
  defaultTimeoutMs: 30_000,
} as const satisfies BashPolicy;
