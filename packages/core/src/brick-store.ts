/**
 * Brick store — persistence contracts for forged artifacts.
 *
 * Backend-agnostic interfaces. Any L2 package can provide a concrete
 * implementation (in-memory, SQLite, Nexus, etc.) by importing only from
 * `@koi/core`.
 */

import type { TrustTier } from "./ecs.js";
import type { KoiError, Result } from "./errors.js";
import type { BrickKind, BrickLifecycle, ForgeScope } from "./forge-types.js";

// ---------------------------------------------------------------------------
// Test case (used by ToolArtifact)
// ---------------------------------------------------------------------------

export interface TestCase {
  readonly name: string;
  readonly input: unknown;
  readonly expectedOutput?: unknown;
  readonly shouldThrow?: boolean;
}

// ---------------------------------------------------------------------------
// Brick requirements (universal — applies to all forgeable brick kinds)
// ---------------------------------------------------------------------------

export interface BrickRequires {
  /** CLI binaries that must exist on PATH (ALL required). */
  readonly bins?: readonly string[];
  /** Environment variables that must be set (ALL required). */
  readonly env?: readonly string[];
  /** Koi tool brick names that must be resolvable. */
  readonly tools?: readonly string[];
}

// ---------------------------------------------------------------------------
// Brick artifact — discriminated union on `kind`
// ---------------------------------------------------------------------------

export interface BrickArtifactBase {
  readonly id: string;
  readonly kind: BrickKind;
  readonly name: string;
  readonly description: string;
  readonly scope: ForgeScope;
  readonly trustTier: TrustTier;
  readonly lifecycle: BrickLifecycle;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly version: string;
  readonly tags: readonly string[];
  readonly usageCount: number;
  /** SHA-256 hex digest of the brick's primary content for integrity verification. */
  readonly contentHash: string;
  /** Optional companion files: relative path → content. */
  readonly files?: Readonly<Record<string, string>>;
  /** Runtime requirements for this brick to be usable. */
  readonly requires?: BrickRequires;
}

export interface ToolArtifact extends BrickArtifactBase {
  readonly kind: "tool";
  readonly implementation: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly testCases?: readonly TestCase[];
}

export interface SkillArtifact extends BrickArtifactBase {
  readonly kind: "skill";
  readonly content: string;
}

export interface AgentArtifact extends BrickArtifactBase {
  readonly kind: "agent";
  readonly manifestYaml: string;
}

export interface CompositeArtifact extends BrickArtifactBase {
  readonly kind: "composite";
  readonly brickIds: readonly string[];
}

export type BrickArtifact = ToolArtifact | SkillArtifact | AgentArtifact | CompositeArtifact;

// ---------------------------------------------------------------------------
// Forge query (structured search)
// ---------------------------------------------------------------------------

export interface ForgeQuery {
  readonly kind?: BrickKind;
  readonly scope?: ForgeScope;
  readonly trustTier?: TrustTier;
  readonly lifecycle?: BrickLifecycle;
  readonly tags?: readonly string[];
  readonly createdBy?: string;
  /** Case-insensitive substring match against brick name and description. */
  readonly text?: string;
  readonly limit?: number;
}

// ---------------------------------------------------------------------------
// Brick update (partial field overwrite)
// ---------------------------------------------------------------------------

export interface BrickUpdate {
  readonly lifecycle?: BrickLifecycle;
  readonly trustTier?: TrustTier;
  readonly scope?: ForgeScope;
  readonly usageCount?: number;
}

// ---------------------------------------------------------------------------
// ForgeStore — repository interface for brick persistence
// ---------------------------------------------------------------------------

export interface ForgeStore {
  readonly save: (brick: BrickArtifact) => Promise<Result<void, KoiError>>;
  readonly load: (id: string) => Promise<Result<BrickArtifact, KoiError>>;
  readonly search: (query: ForgeQuery) => Promise<Result<readonly BrickArtifact[], KoiError>>;
  readonly remove: (id: string) => Promise<Result<void, KoiError>>;
  readonly update: (id: string, updates: BrickUpdate) => Promise<Result<void, KoiError>>;
  readonly exists: (id: string) => Promise<Result<boolean, KoiError>>;
}

// ---------------------------------------------------------------------------
// Advisory lock — orthogonal to ForgeStore, for backends that support it
// ---------------------------------------------------------------------------

declare const __lockBrand: unique symbol;

export type LockHandle = string & { readonly [__lockBrand]: "LockHandle" };

export type LockMode = "shared" | "exclusive";

export interface LockRequest {
  readonly resource: string;
  readonly mode: LockMode;
  readonly ttlMs: number;
}

export interface AdvisoryLock {
  readonly acquire: (request: LockRequest) => Promise<Result<LockHandle, KoiError>>;
  readonly release: (handle: LockHandle) => Promise<Result<void, KoiError>>;
}
