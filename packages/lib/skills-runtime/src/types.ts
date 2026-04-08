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
// Skill metadata (frontmatter only — no body, no security scan)
// ---------------------------------------------------------------------------

/**
 * Metadata for a discovered skill, derived from frontmatter only.
 * Available after discover() without needing to call load().
 * Does not include the skill body.
 */
export interface SkillMetadata {
  /** Skill name from frontmatter (matches directory name by convention). */
  readonly name: string;
  /** Human-readable description from frontmatter. */
  readonly description: string;
  /** Which tier this skill came from. */
  readonly source: SkillSource;
  /** Absolute path to the skill directory. */
  readonly dirPath: string;
  /** Searchable tags from frontmatter. */
  readonly tags?: readonly string[];
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
// Loaded skill (extends metadata with body)
// ---------------------------------------------------------------------------

/**
 * A fully loaded, validated, and security-scanned skill.
 * Returned by SkillsRuntime.load() on success.
 * Extends SkillMetadata — all metadata fields are present plus the body.
 */
export interface SkillDefinition extends SkillMetadata {
  /** Full markdown body (after frontmatter stripped, includes resolved). */
  readonly body: string;
}

// ---------------------------------------------------------------------------
// Registry query filter
// ---------------------------------------------------------------------------

/**
 * Filter for SkillsRuntime.query().
 * All conditions are AND-ed. Multi-tag uses AND semantics (skill must have ALL tags).
 */
export interface SkillQuery {
  /** Filter to skills from a specific source tier. */
  readonly source?: SkillSource;
  /**
   * Filter to skills that have ALL of the specified tags (AND semantics).
   * Skills with no tags field are excluded when this is specified.
   */
  readonly tags?: readonly string[];
  /** Filter to skills that list this tool in their allowedTools. */
  readonly capability?: string;
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
   * Discovers all available skills across all enabled source tiers.
   * Returns a map of skill name → SkillMetadata (frontmatter fields, no body).
   * Subsequent calls return the cached result — no re-scanning.
   *
   * Concurrent calls are safe: only one filesystem scan is performed.
   */
  readonly discover: () => Promise<Result<ReadonlyMap<string, SkillMetadata>, KoiError>>;

  /**
   * Loads a single skill by name: parse → validate → security scan → cache.
   * Subsequent calls for the same name return the cached result.
   * Concurrent calls for the same name are deduplicated — one load runs.
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
   * Returns an outer Result for discovery failures, inner Results per skill.
   * Partial failures do not block other skills from loading.
   */
  readonly loadAll: () => Promise<
    Result<ReadonlyMap<string, Result<SkillDefinition, KoiError>>, KoiError>
  >;

  /**
   * Queries discovered skill metadata without loading bodies.
   * Runs discover() if not yet called. All filter conditions are AND-ed.
   * Multi-tag filter uses AND semantics (skill must have ALL specified tags).
   */
  readonly query: (filter?: SkillQuery) => Promise<Result<readonly SkillMetadata[], KoiError>>;

  /**
   * Invalidates cached skill data.
   * - invalidate(name): clears the body cache for a specific skill only.
   *   Metadata from discover() is preserved. Use after a skill file changes.
   * - invalidate(): full reset — clears discovery cache and all body caches.
   *   Next discover() or load() re-scans the filesystem.
   */
  readonly invalidate: (name?: string) => void;
}
