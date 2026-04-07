/**
 * Public types for @koi/skills-runtime.
 */

import type { KoiError, Result } from "@koi/core";
import type { ScanFinding } from "@koi/skill-scanner";
import type { Severity } from "@koi/validation";

// ---------------------------------------------------------------------------
// Skill source tier
// ---------------------------------------------------------------------------

/**
 * The origin tier of a discovered skill.
 * Precedence: project > user > bundled.
 */
export type SkillSource = "bundled" | "user" | "project";

// ---------------------------------------------------------------------------
// Validated requires (Zod-transformed from YAML `requires` block)
// ---------------------------------------------------------------------------

/** Runtime requirements parsed from a skill's YAML frontmatter. */
export interface ValidatedSkillRequires {
  readonly bins?: readonly string[];
  readonly env?: readonly string[];
  readonly tools?: readonly string[];
  readonly network?: boolean;
  readonly platform?: readonly string[];
}

// ---------------------------------------------------------------------------
// Loaded skill
// ---------------------------------------------------------------------------

/**
 * A fully loaded, validated, and security-scanned skill.
 * Returned by SkillsRuntime.load() on success.
 */
export interface SkillDefinition {
  /** Skill name (matches directory name). */
  readonly name: string;
  /** Human-readable description from frontmatter. */
  readonly description: string;
  /** Full markdown body (after frontmatter stripped, includes resolved). */
  readonly body: string;
  /** Which tier this skill came from. */
  readonly source: SkillSource;
  /** Absolute path to the skill directory. */
  readonly dirPath: string;
  /** SPDX license identifier from frontmatter. */
  readonly license?: string;
  /** Claude Code compatibility string from frontmatter. */
  readonly compatibility?: string;
  /** Allowed tool names from frontmatter `allowed-tools`. */
  readonly allowedTools?: readonly string[];
  /** Runtime requirements parsed from frontmatter `requires`. */
  readonly requires?: ValidatedSkillRequires;
  /** Extra string key-value pairs from frontmatter. */
  readonly metadata?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Runtime config
// ---------------------------------------------------------------------------

export interface SkillsRuntimeConfig {
  /**
   * Project-local skills root (contains named subdirectories).
   * Default: `.claude/skills` relative to CWD.
   */
  readonly projectRoot?: string;
  /**
   * User-level skills root.
   * Default: `~/.claude/skills`.
   */
  readonly userRoot?: string;
  /**
   * Bundled skills root (package-internal).
   * Default: `bundled/` directory next to the package entry point.
   * Pass `null` to disable bundled skills entirely.
   */
  readonly bundledRoot?: string | null;
  /**
   * Severity level at or above which a scan finding blocks the skill from loading.
   * Default: "HIGH".
   */
  readonly blockOnSeverity?: Severity;
  /**
   * Called when a lower-tier skill is shadowed by a higher-priority source.
   */
  readonly onShadowedSkill?: (name: string, shadowedBy: SkillSource) => void;
  /**
   * Called when a skill passes the security gate but has sub-threshold findings.
   * Use this for logging or telemetry.
   */
  readonly onSecurityFinding?: (name: string, findings: readonly ScanFinding[]) => void;
}

// ---------------------------------------------------------------------------
// Runtime interface
// ---------------------------------------------------------------------------

export interface SkillsRuntime {
  /**
   * Discovers all available skill names across all enabled source tiers.
   * Returns a map of skill name → winning SkillSource tier.
   * Does NOT load file content — metadata only.
   */
  readonly discover: () => Promise<Result<ReadonlyMap<string, SkillSource>, KoiError>>;

  /**
   * Loads a single skill by name: parse → validate → security scan → cache.
   * Subsequent calls for the same name return the cached result.
   *
   * Error codes:
   * - NOT_FOUND  — skill not in discovered set
   * - VALIDATION — frontmatter schema error
   * - PERMISSION — scan blocked by severity threshold
   * - INTERNAL   — file I/O or unexpected error
   */
  readonly load: (name: string) => Promise<Result<SkillDefinition, KoiError>>;

  /**
   * Loads all discovered skills in parallel.
   * Each entry is either a successful SkillDefinition or a KoiError.
   * Partial failures do not block other skills from loading.
   */
  readonly loadAll: () => Promise<ReadonlyMap<string, Result<SkillDefinition, KoiError>>>;
}
