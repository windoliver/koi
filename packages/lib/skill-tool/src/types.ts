/**
 * Public types for @koi/skill-tool.
 *
 * Uses structural typing to avoid cross-L2 imports from @koi/skills-runtime.
 * The SkillResolver interface is structurally compatible with SkillsRuntime.
 */

import type { KoiError, Result, SpawnFn } from "@koi/core";

// ---------------------------------------------------------------------------
// Structural skill interfaces (satisfied by @koi/skills-runtime)
// ---------------------------------------------------------------------------

/**
 * Structural interface for skill discovery and loading.
 * Satisfied by `SkillsRuntime` from `@koi/skills-runtime` without explicit
 * `implements` — callers pass the runtime directly as config.
 */
export interface SkillResolver {
  readonly discover: () => Promise<Result<ReadonlyMap<string, SkillMeta>, KoiError>>;
  readonly load: (name: string) => Promise<Result<LoadedSkill, KoiError>>;
}

/**
 * Skill metadata — frontmatter only, no body.
 * Structurally compatible with `SkillMetadata` from `@koi/skills-runtime`.
 */
export interface SkillMeta {
  readonly name: string;
  readonly description: string;
  /** Source tier: "bundled" | "user" | "project". */
  readonly source: string;
  /** Absolute path to the skill directory. */
  readonly dirPath: string;
  readonly tags?: readonly string[];
  readonly allowedTools?: readonly string[];
  /** Execution mode: "inline" (default) or "fork" (sub-agent spawn). */
  readonly executionMode?: "inline" | "fork" | undefined;
  /** Extra string key-value pairs from frontmatter (includes `agent` for fork mode). */
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * Fully loaded skill with body content.
 * Structurally compatible with `SkillDefinition` from `@koi/skills-runtime`.
 */
export interface LoadedSkill extends SkillMeta {
  readonly body: string;
}

// ---------------------------------------------------------------------------
// SkillTool config
// ---------------------------------------------------------------------------

/** Configuration for `createSkillTool()`. */
export interface SkillToolConfig {
  /** Skill resolver (structurally compatible with SkillsRuntime). */
  readonly resolver: SkillResolver;
  /** Spawn function for fork-mode dispatch. Omit to disable fork mode. */
  readonly spawnFn?: SpawnFn;
  /** Factory-level abort signal. Composed with per-call signals. */
  readonly signal: AbortSignal;
  /** Session ID for `${SESSION_ID}` variable substitution. */
  readonly sessionId?: string;
}

// ---------------------------------------------------------------------------
// Variable substitution
// ---------------------------------------------------------------------------

/** Variables available for substitution in skill body templates. */
export interface SkillVariables {
  readonly args?: string;
  readonly skillDir: string;
  readonly sessionId?: string;
}

// ---------------------------------------------------------------------------
// Spawn config (extracted from skill metadata)
// ---------------------------------------------------------------------------

/** Typed spawn configuration extracted from skill frontmatter metadata. */
export interface SpawnConfig {
  readonly agentName: string;
  readonly allowedTools?: readonly string[];
}
