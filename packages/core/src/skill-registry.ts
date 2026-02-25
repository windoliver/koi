/**
 * Skill registry — pluggable skill discovery, publishing, versioning, and installation.
 *
 * Separate from ForgeStore (local brick persistence) and Resolver (generic read-only
 * discovery). The registry models a remote or local package catalog — think npm for skills.
 *
 * Split into SkillRegistryReader (all backends) and SkillRegistryWriter (writable backends).
 * Combined as SkillRegistryBackend for backends that support both.
 *
 * Exception: `skillId()` branded cast is permitted in L0 as a zero-logic identity cast.
 * Exception: `DEFAULT_SKILL_SEARCH_LIMIT` is a pure readonly data constant.
 */

import type { BrickRequires, SkillArtifact } from "./brick-store.js";
import type { KoiError, Result } from "./errors.js";

// ---------------------------------------------------------------------------
// Branded type — SkillId
// ---------------------------------------------------------------------------

declare const __skillIdBrand: unique symbol;

/**
 * Branded string type for skill identifiers.
 * Prevents accidental mixing with agent IDs, session IDs, etc.
 */
export type SkillId = string & { readonly [__skillIdBrand]: "SkillId" };

/** Create a branded SkillId from a plain string. */
export function skillId(raw: string): SkillId {
  return raw as SkillId;
}

// ---------------------------------------------------------------------------
// Structured version
// ---------------------------------------------------------------------------

/** Version metadata for a published skill. */
export interface SkillVersion {
  readonly version: string;
  /** Subresource Integrity hash (e.g., "sha256-..."). */
  readonly integrity?: string;
  /** Unix milliseconds when this version was published. */
  readonly publishedAt: number;
  /** Whether this version has been deprecated. */
  readonly deprecated?: boolean;
}

// ---------------------------------------------------------------------------
// Registry entry — progressive disclosure tier between SkillMetadata and SkillArtifact
// ---------------------------------------------------------------------------

/**
 * Catalog-level skill entry. Richer than SkillMetadata (includes version, author)
 * but lighter than SkillArtifact (no content/implementation).
 */
export interface SkillRegistryEntry {
  readonly id: SkillId;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  /** Latest published version string. */
  readonly version: string;
  /** Unix ms when the latest version was published. */
  readonly publishedAt: number;
  readonly author?: string;
  /** Runtime requirements (bins, env vars, tools). Surfaced at catalog level for filtering. */
  readonly requires?: BrickRequires;
  /** Total install/download count. Optional — not all backends track this. */
  readonly downloads?: number;
}

// ---------------------------------------------------------------------------
// Search + pagination
// ---------------------------------------------------------------------------

export interface SkillSearchQuery {
  /** Case-insensitive text match against name and description. */
  readonly text?: string;
  /** Filter by tags (AND — all specified tags must match). */
  readonly tags?: readonly string[];
  readonly author?: string;
  /** Max items per page. Defaults to DEFAULT_SKILL_SEARCH_LIMIT. */
  readonly limit?: number;
  /** Opaque cursor for the next page. undefined = first page. */
  readonly cursor?: string;
}

/** Default page size for skill search. */
export const DEFAULT_SKILL_SEARCH_LIMIT: 50 = 50;

export interface SkillPage {
  readonly items: readonly SkillRegistryEntry[];
  /** Opaque cursor for the next page. undefined = no more pages. */
  readonly cursor?: string;
  /** Total matching skills. Optional — some backends can't count cheaply. */
  readonly total?: number;
}

// ---------------------------------------------------------------------------
// Change event — typed notification for cache invalidation and update tracking
// ---------------------------------------------------------------------------

/** Describes what changed in the registry. */
export type SkillRegistryChangeKind = "published" | "unpublished" | "deprecated";

/** Notification payload for registry mutations. */
export interface SkillRegistryChangeEvent {
  readonly kind: SkillRegistryChangeKind;
  readonly skillId: SkillId;
  /** Version affected (for published/deprecated events). */
  readonly version?: string;
}

// ---------------------------------------------------------------------------
// Reader (all backends implement)
// ---------------------------------------------------------------------------

export interface SkillRegistryReader {
  /** Search the registry with optional filters and pagination. */
  readonly search: (query: SkillSearchQuery) => SkillPage | Promise<SkillPage>;
  /** Get a single skill entry by ID. */
  readonly get: (
    id: SkillId,
  ) => Result<SkillRegistryEntry, KoiError> | Promise<Result<SkillRegistryEntry, KoiError>>;
  /** List all versions of a skill, newest first. */
  readonly versions: (
    id: SkillId,
  ) =>
    | Result<readonly SkillVersion[], KoiError>
    | Promise<Result<readonly SkillVersion[], KoiError>>;
  /** Download and return a SkillArtifact. Always async (I/O). */
  readonly install: (id: SkillId, version?: string) => Promise<Result<SkillArtifact, KoiError>>;
  /** Optional typed change notification. Returns unsubscribe function. */
  readonly onChange?: (listener: (event: SkillRegistryChangeEvent) => void) => () => void;
}

// ---------------------------------------------------------------------------
// Publish request (input shape for publish)
// ---------------------------------------------------------------------------

export interface SkillPublishRequest {
  readonly id: SkillId;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly version: string;
  /** Markdown source content. */
  readonly content: string;
  readonly author?: string;
  /** Subresource Integrity hash for verification. */
  readonly integrity?: string;
  /** Runtime requirements (bins, env vars, tools) for catalog-level filtering. */
  readonly requires?: BrickRequires;
}

// ---------------------------------------------------------------------------
// Writer (writable backends only)
// ---------------------------------------------------------------------------

export interface SkillRegistryWriter {
  /** Publish a new skill version to the registry. */
  readonly publish: (
    request: SkillPublishRequest,
  ) => Result<SkillRegistryEntry, KoiError> | Promise<Result<SkillRegistryEntry, KoiError>>;
  /** Remove a skill entirely from the registry. */
  readonly unpublish: (id: SkillId) => Result<void, KoiError> | Promise<Result<void, KoiError>>;
  /** Mark a specific version as deprecated. */
  readonly deprecate: (
    id: SkillId,
    version: string,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;
}

// ---------------------------------------------------------------------------
// Combined backend
// ---------------------------------------------------------------------------

/** Full registry backend that supports both reading and writing. */
export interface SkillRegistryBackend extends SkillRegistryReader, SkillRegistryWriter {}
