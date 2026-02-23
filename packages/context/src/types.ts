/**
 * Types for the context hydration system.
 *
 * Defines a discriminated union of 5 source kinds that can be declared
 * in koi.yaml to pre-load context at session start.
 */

import type { Agent } from "@koi/core";

/**
 * Common fields shared by all context source kinds.
 * Each concrete source extends this with its `kind` discriminant and kind-specific fields.
 */
export interface SourceBase {
  readonly label?: string | undefined;
  readonly required?: boolean | undefined;
  readonly priority?: number | undefined;
  readonly maxTokens?: number | undefined;
  /** Whether this source should be re-resolved on refresh intervals. */
  readonly refreshable?: boolean | undefined;
}

/**
 * Discriminated union of context source kinds.
 * Each source specifies what context to pre-load and how.
 */
export type ContextSource = TextSource | FileSource | MemorySource | SkillSource | ToolSchemaSource;

export interface TextSource extends SourceBase {
  readonly kind: "text";
  readonly text: string;
}

export interface FileSource extends SourceBase {
  readonly kind: "file";
  readonly path: string;
}

export interface MemorySource extends SourceBase {
  readonly kind: "memory";
  readonly query: string;
}

export interface SkillSource extends SourceBase {
  readonly kind: "skill";
  readonly name: string;
}

export interface ToolSchemaSource extends SourceBase {
  readonly kind: "tool_schema";
  readonly tools?: readonly string[] | undefined;
}

/** Top-level context configuration from koi.yaml. */
export interface ContextManifestConfig {
  readonly sources: readonly ContextSource[];
  /** Global token budget for all sources combined. Default: 8000. */
  readonly maxTokens?: number | undefined;
  /** Re-resolve refreshable sources every N turns. Requires at least one refreshable source. */
  readonly refreshInterval?: number | undefined;
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

/**
 * Uniform signature for resolving a context source.
 * Built-in resolvers that don't need the agent param simply ignore it.
 */
export type SourceResolver = (
  source: ContextSource,
  agent: Agent,
) => SourceResult | Promise<SourceResult>;
