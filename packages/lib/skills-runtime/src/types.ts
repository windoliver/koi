/**
 * Public types for @koi/skills-runtime.
 */

import type { KoiError, Result, SkillExecutionMode } from "@koi/core";
import type { ScanFinding } from "@koi/skill-scanner";
import type { Severity } from "@koi/validation";

// ---------------------------------------------------------------------------
// Skill source tier
// ---------------------------------------------------------------------------

/**
 * The origin tier of a discovered skill.
 * Precedence (highest first): project > user > bundled > mcp.
 */
export type SkillSource = "bundled" | "user" | "project" | "mcp";

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
// Validated frontmatter (Zod-transformed output)
// ---------------------------------------------------------------------------

/**
 * Validated and normalized output from SKILL.md YAML frontmatter.
 * Base type for SkillMetadata — frontmatter fields flow through automatically.
 */
export interface ValidatedFrontmatter {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly allowedTools?: readonly string[];
  readonly tags?: readonly string[];
  readonly requires?: ValidatedSkillRequires;
  readonly metadata?: Readonly<Record<string, string>>;
  /** Execution mode: "inline" (context injection) or "fork" (sub-agent spawn). */
  readonly executionMode?: SkillExecutionMode | undefined;
  /**
   * Tier 2 reference allowlist (issue #1642, review round 4).
   *
   * Each entry is a relative POSIX path inside the skill directory that
   * `SkillsRuntime.loadReference()` will hand to callers on demand. A skill
   * that does not declare `references:` cannot surface any file via
   * Tier 2 — the API fails closed. This narrows Tier 2 from "any file in
   * the skill subtree" to "only the files the author declared."
   */
  readonly references?: readonly string[];
}

// ---------------------------------------------------------------------------
// Skill metadata (frontmatter only — no body, no security scan)
// ---------------------------------------------------------------------------

/**
 * Metadata for a discovered skill, derived from frontmatter only.
 * Available after discover() without needing to call load().
 * Extends ValidatedFrontmatter with source and location information.
 *
 * `references` is intentionally omitted here (review #1896 round 6). The
 * Tier 2 allowlist is a trust-boundary detail that must not leak through
 * Tier 0 (`discover()` / `query()`) into model context. Consumers that
 * need to authorize a Tier 2 read should call `loadReference()`, which
 * re-parses the frontmatter from disk.
 */
export interface SkillMetadata extends Omit<ValidatedFrontmatter, "references"> {
  /** Which tier this skill came from. */
  readonly source: SkillSource;
  /** Absolute path to the skill directory (or URI for non-filesystem sources). */
  readonly dirPath: string;
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
// Progressive disclosure telemetry (issue #1642)
// ---------------------------------------------------------------------------

/** Fired by SkillsRuntime.load() on every successful resolution. */
export interface SkillLoadedEvent {
  readonly name: string;
  readonly source: SkillSource;
  readonly bodyBytes: number;
  /** True if the body came from the LRU cache; false on first load or reload. */
  readonly cacheHit: boolean;
}

/** Fired when a cached body is evicted. */
export interface SkillEvictedEvent {
  readonly name: string;
  readonly reason: "lru" | "invalidate" | "external-refresh";
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
  /**
   * Maximum number of loaded skill bodies to retain in the LRU cache (issue #1642).
   * When the cache exceeds this bound, the least-recently-used entry is evicted
   * and `onSkillEvicted` fires with `reason: "lru"`.
   * Default: `Infinity` (unbounded; preserves legacy behavior).
   */
  readonly cacheMaxBodies?: number;
  /** Called after discover() with the count of skills admitted to the Tier 0 listing. */
  readonly onMetadataInjected?: (count: number) => void;
  /** Called on every successful load() — distinguishes first-load from cache hits. */
  readonly onSkillLoaded?: (event: SkillLoadedEvent) => void;
  /** Called when a cached body is evicted (LRU, invalidate, or external refresh). */
  readonly onSkillEvicted?: (event: SkillEvictedEvent) => void;
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
   * Tier 2 — reads a file inside the skill directory on demand (issue #1642).
   *
   * `refPath` is a relative path resolved against the skill's directory. The
   * realpath of the result must stay inside the skill directory or the call
   * returns `VALIDATION` with `context.errorKind === "PATH_TRAVERSAL"`. Not
   * cached — reference fetches are one-shot.
   *
   * Error codes:
   * - NOT_FOUND  — skill not in discovered set, or reference file missing
   * - VALIDATION — empty / absolute / traversing / null-byte path
   */
  readonly loadReference: (name: string, refPath: string) => Promise<Result<string, KoiError>>;

  /**
   * Invalidates cached skill data.
   * - invalidate(name): clears the body cache for a specific skill only.
   *   Metadata from discover() is preserved. Use after a skill file changes.
   * - invalidate(): full reset — clears discovery cache and all body caches.
   *   Next discover() or load() re-scans the filesystem.
   */
  readonly invalidate: (name?: string) => void;

  /**
   * Registers non-filesystem skills (e.g., MCP-derived tool descriptors).
   *
   * External skills have lowest precedence — any filesystem skill with the
   * same name shadows them. Replaces all previously registered external skills
   * (full replacement, not incremental merge).
   *
   * Does not trigger filesystem re-scan. Filesystem discovery cache is untouched.
   */
  readonly registerExternal: (skills: readonly SkillMetadata[]) => void;
}
