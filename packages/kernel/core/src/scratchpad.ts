/**
 * Scratchpad types — group-scoped versioned file store (shared memory equivalent).
 *
 * Provides the L0 contract for shared scratchpad storage:
 * - `ScratchpadComponent` — the ECS singleton for read/write/list/delete
 * - `ScratchpadEntry` — a versioned file entry with CAS generation
 * - `ScratchpadChangeEvent` — notification of writes/deletes
 *
 * L2 adapters (e.g., @koi/scratchpad-nexus) provide concrete implementations.
 *
 * Exception: branded type constructors (identity casts) are permitted in L0
 * as zero-logic operations for type safety.
 * Exception: pure readonly data constants (SCRATCHPAD_DEFAULTS) codify
 * architecture-doc invariants with zero logic.
 */

import type { JsonObject } from "./common.js";
import type { AgentId } from "./ecs.js";
import type { KoiError, Result } from "./errors.js";

// ---------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------

// AgentGroupId type and constructor are in ecs.ts (canonical location)
import type { AgentGroupId } from "./ecs.js";

export type { AgentGroupId } from "./ecs.js";

declare const __scratchpadPathBrand: unique symbol;

/**
 * Branded string type for scratchpad file paths.
 * Must not contain `..`, must not start with `/`, max length enforced by constants.
 */
export type ScratchpadPath = string & { readonly [__scratchpadPathBrand]: "ScratchpadPath" };

/** Create a branded ScratchpadPath from a plain string. */
export function scratchpadPath(raw: string): ScratchpadPath {
  return raw as ScratchpadPath;
}

/**
 * CAS version counter for scratchpad entries.
 * - `0` in expectedGeneration = create-only (fail if exists)
 * - `undefined` in expectedGeneration = unconditional write
 * - `>0` in expectedGeneration = CAS update (fail on mismatch)
 */
export type ScratchpadGeneration = number;

// ---------------------------------------------------------------------------
// Scratchpad entry
// ---------------------------------------------------------------------------

/** A versioned file entry in the shared scratchpad. */
export interface ScratchpadEntry {
  readonly path: ScratchpadPath;
  readonly content: string;
  readonly generation: ScratchpadGeneration;
  readonly groupId: AgentGroupId;
  readonly authorId: AgentId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sizeBytes: number;
  readonly ttlSeconds?: number | undefined;
  readonly metadata?: JsonObject | undefined;
}

/** Summary of a scratchpad entry (no content — for listing). */
export type ScratchpadEntrySummary = Omit<ScratchpadEntry, "content">;

// ---------------------------------------------------------------------------
// Write input/result
// ---------------------------------------------------------------------------

/**
 * Input for scratchpad write operations.
 *
 * CAS semantics via `expectedGeneration`:
 * - `0` = create-only (fail with CONFLICT if path already exists)
 * - `undefined` = unconditional write (overwrite any existing version)
 * - `>0` = CAS update (fail with CONFLICT if current generation differs)
 */
export interface ScratchpadWriteInput {
  readonly path: ScratchpadPath;
  readonly content: string;
  readonly expectedGeneration?: ScratchpadGeneration | undefined;
  readonly ttlSeconds?: number | undefined;
  readonly metadata?: JsonObject | undefined;
}

/** Result of a successful scratchpad write. */
export interface ScratchpadWriteResult {
  readonly path: ScratchpadPath;
  readonly generation: ScratchpadGeneration;
  readonly sizeBytes: number;
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

/** Declarative filter for listing scratchpad entries. */
export interface ScratchpadFilter {
  readonly glob?: string | undefined;
  readonly authorId?: AgentId | undefined;
  readonly limit?: number | undefined;
}

// ---------------------------------------------------------------------------
// Change event
// ---------------------------------------------------------------------------

/** Notification of a scratchpad write or delete. */
export type ScratchpadChangeEvent =
  | {
      readonly kind: "written";
      readonly path: ScratchpadPath;
      readonly generation: ScratchpadGeneration;
      readonly authorId: AgentId;
      readonly groupId: AgentGroupId;
      readonly timestamp: string;
    }
  | {
      readonly kind: "deleted";
      readonly path: ScratchpadPath;
      readonly generation: ScratchpadGeneration;
      readonly authorId: AgentId;
      readonly groupId: AgentGroupId;
      readonly timestamp: string;
    };

// ---------------------------------------------------------------------------
// Scratchpad component (ECS singleton)
// ---------------------------------------------------------------------------

/**
 * ECS singleton component for group-scoped versioned file storage.
 *
 * - `write` — write a file with optional CAS concurrency control
 * - `read` — read a file by path
 * - `list` — list entry summaries with optional filter
 * - `delete` — delete a file by path
 * - `flush` — flush pending writes to backend
 * - `onChange` — subscribe to change events (returns unsubscribe fn)
 */
export interface ScratchpadComponent {
  readonly write: (
    input: ScratchpadWriteInput,
  ) => Result<ScratchpadWriteResult, KoiError> | Promise<Result<ScratchpadWriteResult, KoiError>>;
  readonly read: (
    path: ScratchpadPath,
  ) => Result<ScratchpadEntry, KoiError> | Promise<Result<ScratchpadEntry, KoiError>>;
  readonly list: (
    filter?: ScratchpadFilter,
  ) => readonly ScratchpadEntrySummary[] | Promise<readonly ScratchpadEntrySummary[]>;
  readonly delete: (
    path: ScratchpadPath,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;
  readonly flush: () => void | Promise<void>;
  readonly onChange: (handler: (event: ScratchpadChangeEvent) => void) => () => void;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default configuration constants for scratchpad storage. */
export const SCRATCHPAD_DEFAULTS: Readonly<{
  readonly MAX_FILE_SIZE_BYTES: 1_048_576;
  readonly MAX_FILES_PER_GROUP: 1_000;
  readonly DEFAULT_TTL_SECONDS: 86_400;
  readonly MAX_PATH_LENGTH: 256;
}> = Object.freeze({
  MAX_FILE_SIZE_BYTES: 1_048_576,
  MAX_FILES_PER_GROUP: 1_000,
  DEFAULT_TTL_SECONDS: 86_400,
  MAX_PATH_LENGTH: 256,
} as const);
