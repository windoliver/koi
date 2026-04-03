/**
 * BrickRegistryBase — generic brick discovery, publishing, and installation.
 *
 * Shared reader/writer base with cursor-based pagination.
 * Per-kind extensions (e.g., ToolRegistryReader with inputSchema search)
 * can extend these interfaces without duplicating the base surface.
 */

import type { BrickArtifact } from "./brick-store.js";
import type { KoiError, Result } from "./errors.js";
import type { BrickKind } from "./forge-types.js";

// ---------------------------------------------------------------------------
// Search query + pagination
// ---------------------------------------------------------------------------

export interface BrickSearchQuery {
  readonly kind?: BrickKind;
  readonly text?: string;
  readonly tags?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string;
  /** Filter by community namespace (e.g., "@author"). */
  readonly namespace?: string;
}

export const DEFAULT_BRICK_SEARCH_LIMIT: 50 = 50;

export interface BrickPage {
  readonly items: readonly BrickArtifact[];
  readonly cursor?: string;
  readonly total?: number;
}

// ---------------------------------------------------------------------------
// Change events
// ---------------------------------------------------------------------------

export type BrickRegistryChangeKind = "registered" | "unregistered" | "updated";

export interface BrickRegistryChangeEvent {
  readonly kind: BrickRegistryChangeKind;
  readonly brickKind: BrickKind;
  readonly name: string;
}

// ---------------------------------------------------------------------------
// Reader / Writer / Backend
// ---------------------------------------------------------------------------

export interface BrickRegistryReader {
  readonly search: (query: BrickSearchQuery) => BrickPage | Promise<BrickPage>;
  readonly get: (
    kind: BrickKind,
    name: string,
    namespace?: string,
  ) => Result<BrickArtifact, KoiError> | Promise<Result<BrickArtifact, KoiError>>;
  readonly onChange?: (listener: (event: BrickRegistryChangeEvent) => void) => () => void;
}

export interface BrickRegistryWriter {
  readonly register: (
    brick: BrickArtifact,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;
  readonly unregister: (
    kind: BrickKind,
    name: string,
  ) => Result<void, KoiError> | Promise<Result<void, KoiError>>;
}

export interface BrickRegistryBackend extends BrickRegistryReader, BrickRegistryWriter {}
