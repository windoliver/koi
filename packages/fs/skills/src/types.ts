/**
 * Progressive loading types for Agent Skills Standard.
 *
 * Three levels: metadata (frontmatter only), body (+ markdown), bundled (+ scripts/references).
 */

import type { ComponentProvider, KoiError, Result, SkillConfig } from "@koi/core";
import type { ScanFinding } from "@koi/skill-scanner";

/** Discriminant for progressive loading depth. */
export type SkillLoadLevel = "metadata" | "body" | "bundled";

/** Bundled script file content. */
export interface SkillScript {
  readonly filename: string;
  readonly content: string;
}

/** Bundled reference file content. */
export interface SkillReference {
  readonly filename: string;
  readonly content: string;
}

/** Shared base for all skill entry levels. */
interface SkillEntryBase {
  readonly name: string;
  readonly description: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly allowedTools?: readonly string[];
  /** Absolute path to the skill directory. */
  readonly dirPath: string;
}

/** Level 1: frontmatter only — cheapest to load. */
export interface SkillMetadataEntry extends SkillEntryBase {
  readonly level: "metadata";
}

/** Level 2: frontmatter + markdown body. */
export interface SkillBodyEntry extends SkillEntryBase {
  readonly level: "body";
  readonly body: string;
}

/** Level 3: frontmatter + body + bundled scripts and references. */
export interface SkillBundledEntry extends SkillEntryBase {
  readonly level: "bundled";
  readonly body: string;
  readonly scripts: readonly SkillScript[];
  readonly references: readonly SkillReference[];
}

/** Discriminated union of all progressive loading levels. */
export type SkillEntry = SkillMetadataEntry | SkillBodyEntry | SkillBundledEntry;

// ---------------------------------------------------------------------------
// Progressive provider
// ---------------------------------------------------------------------------

/** Numeric ordering for load level comparisons. */
export const LEVEL_ORDER: Readonly<Record<SkillLoadLevel, number>> = {
  metadata: 0,
  body: 1,
  bundled: 2,
} as const;

/** Returns true when `current` is at or above `target` in the load hierarchy. */
export function isAtOrAbove(current: SkillLoadLevel, target: SkillLoadLevel): boolean {
  return LEVEL_ORDER[current] >= LEVEL_ORDER[target];
}

// ---------------------------------------------------------------------------
// Include resolution
// ---------------------------------------------------------------------------

/** A resolved include file with its path and content. */
export interface ResolvedInclude {
  readonly path: string;
  readonly content: string;
}

/** Options for resolving `includes` directives in SKILL.md frontmatter. */
export interface IncludeResolutionOptions {
  /** Root directory for security boundary — resolved paths must stay within this. */
  readonly skillsRoot: string;
  /** Maximum recursion depth for nested includes. Default: 3. */
  readonly maxDepth?: number;
}

// ---------------------------------------------------------------------------
// Progressive provider
// ---------------------------------------------------------------------------

/** Extended ComponentProvider with dynamic level promotion and hot-plug. */
export interface ProgressiveSkillProvider extends ComponentProvider {
  /** Promote a skill to a higher load level. No-op if already at target level. */
  readonly promote: (name: string, targetLevel?: SkillLoadLevel) => Promise<Result<void, KoiError>>;
  /** Query the current load level for a skill. Returns undefined if skill not found. */
  readonly getLevel: (name: string) => SkillLoadLevel | undefined;
  /** Hot-mount a skill at runtime. Loads at "body" level and runs security scan. */
  readonly mount?: (
    skill: SkillConfig,
    basePath: string,
    onSecurityFinding?: (name: string, findings: readonly ScanFinding[]) => void,
  ) => Promise<Result<void, KoiError>>;
  /** Hot-unmount a skill by name. */
  readonly unmount?: (name: string) => void;
}
