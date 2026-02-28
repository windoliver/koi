/**
 * Brick snapshot types — version history, provenance tracking, and diff.
 *
 * Orthogonal to ForgeStore (like AdvisoryLock). Enables versioning,
 * rollback, and audit trails for all forged/bundled/extension bricks.
 */

import type { KoiError, Result } from "./errors.js";
import type { BrickKind } from "./forge-types.js";

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

declare const __brickIdBrand: unique symbol;

/**
 * Branded string for brick identity.
 * Prevents mixing brick IDs with other string-typed IDs at compile time.
 */
export type BrickId = string & { readonly [__brickIdBrand]: "BrickId" };

/** Create a BrickId from a raw string. */
export function brickId(raw: string): BrickId {
  return raw as BrickId;
}

declare const __snapshotIdBrand: unique symbol;

/**
 * Branded string for snapshot identity.
 * Each snapshot is a unique immutable version record.
 */
export type SnapshotId = string & { readonly [__snapshotIdBrand]: "SnapshotId" };

/** Create a SnapshotId from a raw string. */
export function snapshotId(raw: string): SnapshotId {
  return raw as SnapshotId;
}

// ---------------------------------------------------------------------------
// BrickRef — lightweight pointer to a brick + version
// ---------------------------------------------------------------------------

export interface BrickRef {
  readonly id: BrickId;
  readonly version: string;
  readonly kind: BrickKind;
}

// ---------------------------------------------------------------------------
// BrickSource — provenance tracking (where did this brick come from?)
// ---------------------------------------------------------------------------

export type BrickSource =
  | {
      readonly origin: "forged";
      readonly forgedBy: string;
      readonly sessionId?: string;
    }
  | {
      readonly origin: "bundled";
      readonly bundleName: string;
      readonly bundleVersion: string;
    }
  | {
      readonly origin: "external";
      readonly registry: string;
      readonly packageRef: string;
    };

// ---------------------------------------------------------------------------
// SnapshotEvent — discriminated union of version events
// ---------------------------------------------------------------------------

export type SnapshotEvent =
  | {
      readonly kind: "created";
      readonly actor: string;
      readonly timestamp: number;
    }
  | {
      readonly kind: "updated";
      readonly actor: string;
      readonly timestamp: number;
      readonly fieldsChanged: readonly string[];
    }
  | {
      readonly kind: "promoted";
      readonly actor: string;
      readonly timestamp: number;
      readonly fromTier: string;
      readonly toTier: string;
    }
  | {
      readonly kind: "deprecated";
      readonly actor: string;
      readonly timestamp: number;
      readonly reason: string;
    }
  | {
      readonly kind: "quarantined";
      readonly actor: string;
      readonly timestamp: number;
      readonly reason: string;
      readonly errorRate: number;
      readonly failureCount: number;
    }
  | {
      readonly kind: "demoted";
      readonly actor: string;
      readonly timestamp: number;
      readonly fromTier: string;
      readonly toTier: string;
      readonly reason: string;
      readonly errorRate: number;
    };

// ---------------------------------------------------------------------------
// BrickSnapshot — immutable version record
// ---------------------------------------------------------------------------

export interface BrickSnapshot {
  readonly snapshotId: SnapshotId;
  readonly brickId: BrickId;
  readonly version: string;
  readonly parentSnapshotId?: SnapshotId;
  readonly source: BrickSource;
  readonly event: SnapshotEvent;
  /** Opaque artifact data — like EngineState.data, zero assumptions about structure. */
  readonly artifact: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

// ---------------------------------------------------------------------------
// SnapshotQuery — structured query for snapshot retrieval
// ---------------------------------------------------------------------------

export interface SnapshotQuery {
  readonly brickId?: BrickId;
  readonly version?: string;
  readonly afterTimestamp?: number;
  readonly beforeTimestamp?: number;
  readonly limit?: number;
}

// ---------------------------------------------------------------------------
// SnapshotStore — orthogonal interface (like AdvisoryLock)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `SnapshotChainStore<BrickSnapshot>` from `snapshot-chain.ts` instead.
 * This interface lacks DAG/fork/history semantics. Retained for backward compatibility.
 */
export interface SnapshotStore {
  readonly record: (snapshot: BrickSnapshot) => Promise<Result<void, KoiError>>;
  readonly get: (id: SnapshotId) => Promise<Result<BrickSnapshot, KoiError>>;
  readonly list: (query: SnapshotQuery) => Promise<Result<readonly BrickSnapshot[], KoiError>>;
  readonly history: (brickId: BrickId) => Promise<Result<readonly BrickSnapshot[], KoiError>>;
  readonly latest: (brickId: BrickId) => Promise<Result<BrickSnapshot, KoiError>>;
}
