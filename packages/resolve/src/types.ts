/**
 * Core types for the manifest resolution layer.
 *
 * Bridges declarative koi.yaml configuration to runtime instances
 * via a registry of BrickDescriptors.
 */

import type {
  AgentManifest,
  BrickKind,
  ChannelAdapter,
  CompanionSkillDefinition,
  EngineAdapter,
  JsonObject,
  KoiError,
  KoiMiddleware,
  ModelHandler,
  Result,
} from "@koi/core";
import type { SearchProvider } from "@koi/search-provider";

// ---------------------------------------------------------------------------
// Resolve kind — extends BrickKind with resolution-specific kinds
// ---------------------------------------------------------------------------

/** Kinds supported by the resolution layer. Extends L0 BrickKind. */
export type ResolveKind =
  | BrickKind
  | "model"
  | "engine"
  | "context"
  | "forge"
  | "schedule"
  | "search"
  | "webhook";

// ---------------------------------------------------------------------------
// Options validation
// ---------------------------------------------------------------------------

/**
 * Validates raw YAML options into a typed config.
 * Compatible with Zod (wrap safeParse in Result) or manual validators.
 */
export type OptionsValidator<T> = (input: unknown) => Result<T, KoiError>;

// ---------------------------------------------------------------------------
// BrickDescriptor — the standardized factory interface every L2 package exports
// ---------------------------------------------------------------------------

/**
 * Factory signature — receives validated options + resolution context,
 * returns a runtime instance.
 */
export type BrickFactory<T> = (options: JsonObject, context: ResolutionContext) => T | Promise<T>;

/**
 * A BrickDescriptor binds a name to a factory + options validator.
 * Every L2 package that participates in manifest auto-resolution exports one.
 */
export interface BrickDescriptor<T> {
  /** What kind of brick this descriptor creates. */
  readonly kind: ResolveKind;
  /** Canonical name (e.g., "@koi/soul", "anthropic"). */
  readonly name: string;
  /** Short aliases for convenience (e.g., ["soul", "memory"]). */
  readonly aliases?: readonly string[];
  /** Human-readable description of what this brick does. */
  readonly description?: string;
  /** Searchable tags for categorization and discovery. */
  readonly tags?: readonly string[];
  /** Skills auto-injected into copilot context to teach the LLM when to use this brick. */
  readonly companionSkills?: readonly CompanionSkillDefinition[];
  /** Validates raw YAML options into typed config. */
  readonly optionsValidator: OptionsValidator<unknown>;
  /** Creates the runtime instance from validated options. */
  readonly factory: BrickFactory<T>;
}

// ---------------------------------------------------------------------------
// Resolution context — provided to factories during resolution
// ---------------------------------------------------------------------------

/** Handler for human-in-the-loop approval of tool calls. */
export interface ResolveApprovalHandler {
  readonly requestApproval: (toolId: string, input: JsonObject, reason: string) => Promise<boolean>;
}

/**
 * Runtime context provided to brick factories during resolution.
 * Provides access to manifest metadata and environment.
 */
export interface ResolutionContext {
  /** Directory containing koi.yaml — used as basePath for relative file refs. */
  readonly manifestDir: string;
  /** The full manifest (for cross-section references). */
  readonly manifest: AgentManifest;
  /** Process environment (for API key lookup). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Approval handler from CLI runtime (for permissions ask rules). */
  readonly approvalHandler?: ResolveApprovalHandler | undefined;
}

// ---------------------------------------------------------------------------
// Registry — maps (kind, name) pairs to descriptors
// ---------------------------------------------------------------------------

/** Read-only registry of brick descriptors. */
export interface ResolveRegistry {
  /** Look up a descriptor by kind and name (or alias). */
  readonly get: (kind: ResolveKind, name: string) => BrickDescriptor<unknown> | undefined;
  /** Check if a descriptor exists for the given kind and name (or alias). */
  readonly has: (kind: ResolveKind, name: string) => boolean;
  /** List all descriptors of a given kind. */
  readonly list: (kind: ResolveKind) => readonly BrickDescriptor<unknown>[];
}

// ---------------------------------------------------------------------------
// Resolution results
// ---------------------------------------------------------------------------

/** Result of resolving the middleware section — includes warnings for skipped optional middleware. */
export interface MiddlewareResolutionResult {
  readonly middleware: readonly KoiMiddleware[];
  readonly warnings: readonly string[];
}

/** What resolveManifest() returns on success. */
export interface ResolvedManifest {
  /** Merged and priority-sorted middleware (explicit + soul + permissions). */
  readonly middleware: readonly KoiMiddleware[];
  /** Resolved model handler ready for createLoopAdapter. */
  readonly model: ModelHandler;
  /** Resolved channel adapters (undefined → CLI defaults to channel-cli). */
  readonly channels?: readonly ChannelAdapter[] | undefined;
  /** Resolved engine adapter (undefined → CLI defaults to loop adapter). */
  readonly engine?: EngineAdapter | undefined;
  /** Resolved search provider (undefined → no web search capability). */
  readonly search?: SearchProvider | undefined;
  /** Warnings from optional middleware that failed to resolve. */
  readonly warnings: readonly string[];
}

/** A single resolution failure within a section. */
export interface ResolutionFailure {
  /** Which manifest section failed ("middleware", "model", "soul", "permissions"). */
  readonly section: string;
  /** Item index within the section (for arrays like middleware). */
  readonly index?: number;
  /** The name that failed to resolve. */
  readonly name: string;
  /** The underlying error. */
  readonly error: KoiError;
}
