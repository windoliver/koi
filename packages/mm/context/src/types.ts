/**
 * Types for the context hydration system.
 *
 * Defines a discriminated union of 6 source kinds that can be declared
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
export type ContextSource =
  | TextSource
  | FileSource
  | MemorySource
  | SkillSource
  | ToolSchemaSource
  | CollectiveMemoryContextSource;

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

export interface CollectiveMemoryContextSource extends SourceBase {
  readonly kind: "collective_memory";
  /** Optional override brick ID. Default: resolved from agent's own brick. */
  readonly brickId?: string | undefined;
}

/** Per-slot overrides for bootstrap file resolution. */
export interface BootstrapSlotConfig {
  readonly fileName: string;
  readonly label?: string | undefined;
  readonly budget?: number | undefined;
}

/** Object-form configuration for `context.bootstrap`. */
export interface BootstrapManifestConfig {
  /** Root directory for .koi/ hierarchy. Relative to manifest file location. */
  readonly rootDir?: string | undefined;
  /** Agent name for agent-specific overrides. null = disable agent-specific resolution. */
  readonly agentName?: string | null | undefined;
  /** Custom slot definitions overriding the default INSTRUCTIONS/TOOLS/CONTEXT slots. */
  readonly slots?: readonly BootstrapSlotConfig[] | undefined;
}

/** Top-level context configuration from koi.yaml. */
export interface ContextManifestConfig {
  /** Explicit context sources. Optional when bootstrap is enabled. */
  readonly sources?: readonly ContextSource[] | undefined;
  /** Auto-resolve .koi/ file hierarchy. true = defaults, object = custom config. */
  readonly bootstrap?: boolean | BootstrapManifestConfig | undefined;
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
