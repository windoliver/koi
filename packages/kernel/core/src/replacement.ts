/**
 * Content replacement contracts for large tool result management.
 *
 * Defines the pluggable storage interface and branded reference type.
 * L2 packages implement the store (in-memory, filesystem, cloud).
 *
 * Exception: branded type constructor (replacementRef) is permitted in L0
 * as it is a zero-logic identity cast for type safety.
 */

// ---------------------------------------------------------------------------
// Branded reference type
// ---------------------------------------------------------------------------

declare const __replacementRefBrand: unique symbol;

/**
 * Branded string for content replacement references.
 *
 * Typically a content hash (SHA-256 hex), but the format is
 * store-implementation-defined. Consumer code must not parse it.
 */
export type ReplacementRef = string & { readonly [__replacementRefBrand]: "ReplacementRef" };

/** Create a branded ReplacementRef from a plain string. */
export function replacementRef(ref: string): ReplacementRef {
  return ref as ReplacementRef;
}

// ---------------------------------------------------------------------------
// Replacement store contract
// ---------------------------------------------------------------------------

/**
 * Content-addressed store for replaced tool result content.
 *
 * Implementations must satisfy:
 * - **Round-trip**: `get(put(content))` returns `content`.
 * - **Idempotency**: `put(content)` always returns the same ref for identical content.
 * - **Graceful miss**: `get(unknownRef)` returns `undefined`, never throws.
 *
 * Supports sync (in-memory) and async (filesystem, cloud) via `T | Promise<T>`.
 */
export interface ReplacementStore {
  /** Store content and return a reference for later retrieval. */
  readonly put: (content: string) => ReplacementRef | Promise<ReplacementRef>;

  /** Retrieve content by reference. Returns undefined if not found. */
  readonly get: (ref: ReplacementRef) => string | undefined | Promise<string | undefined>;

  /**
   * Remove stored content not referenced by any active message.
   *
   * Called after compaction passes to prevent memory/storage leaks.
   * Implementations delete any stored content whose ref is not in `activeRefs`.
   */
  readonly cleanup: (activeRefs: ReadonlySet<ReplacementRef>) => void | Promise<void>;
}
