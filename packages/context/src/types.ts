/**
 * Types for the context hydration system.
 *
 * Defines a discriminated union of 5 source kinds that can be declared
 * in koi.yaml to pre-load context at session start.
 */

/**
 * Discriminated union of context source kinds.
 * Each source specifies what context to pre-load and how.
 */
export type ContextSource = TextSource | FileSource | MemorySource | SkillSource | ToolSchemaSource;

export interface TextSource {
  readonly kind: "text";
  readonly text: string;
  readonly label?: string | undefined;
  readonly required?: boolean | undefined;
  readonly priority?: number | undefined;
  readonly maxTokens?: number | undefined;
}

export interface FileSource {
  readonly kind: "file";
  readonly path: string;
  readonly label?: string | undefined;
  readonly required?: boolean | undefined;
  readonly priority?: number | undefined;
  readonly maxTokens?: number | undefined;
}

export interface MemorySource {
  readonly kind: "memory";
  readonly query: string;
  readonly label?: string | undefined;
  readonly required?: boolean | undefined;
  readonly priority?: number | undefined;
  readonly maxTokens?: number | undefined;
}

export interface SkillSource {
  readonly kind: "skill";
  readonly name: string;
  readonly label?: string | undefined;
  readonly required?: boolean | undefined;
  readonly priority?: number | undefined;
  readonly maxTokens?: number | undefined;
}

export interface ToolSchemaSource {
  readonly kind: "tool_schema";
  readonly tools?: readonly string[] | undefined;
  readonly label?: string | undefined;
  readonly required?: boolean | undefined;
  readonly priority?: number | undefined;
  readonly maxTokens?: number | undefined;
}

/** Top-level context configuration from koi.yaml. */
export interface ContextManifestConfig {
  readonly sources: readonly ContextSource[];
  /** Global token budget for all sources combined. Default: 8000. */
  readonly maxTokens?: number | undefined;
}

/** Result of hydrating a single source. */
export interface SourceResult {
  readonly label: string;
  readonly content: string;
  readonly tokens: number;
  readonly source: ContextSource;
}

/** Result of the full hydration pass. */
export interface HydrationResult {
  /** Assembled system message content. */
  readonly content: string;
  /** Total estimated tokens across all included sources. */
  readonly totalTokens: number;
  /** Individual source results that were included. */
  readonly sources: readonly SourceResult[];
  /** Warnings for non-required sources that failed or were dropped. */
  readonly warnings: readonly string[];
}
