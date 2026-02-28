/**
 * Progressive loading types for Agent Skills Standard.
 *
 * Three levels: metadata (frontmatter only), body (+ markdown), bundled (+ scripts/references).
 */

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
