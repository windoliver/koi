/**
 * In-memory reference implementation of VersionIndexBackend.
 *
 * Suitable for testing and as a reference for L2 implementations.
 * All methods are synchronous (return Result<T> directly).
 */

import type {
  BrickId,
  BrickKind,
  KoiError,
  PublisherId,
  Result,
  VersionChangeEvent,
  VersionEntry,
  VersionIndexBackend,
} from "@koi/core";
import { conflict, notFound, validation } from "@koi/core";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Composite key for the two-level map: kind + name. */
function compositeKey(name: string, kind: BrickKind): string {
  return `${kind}:${name}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create an in-memory VersionIndexBackend for testing. */
export function createInMemoryVersionIndex(): VersionIndexBackend {
  // Mutable internal state — exposed only through immutable return values
  // Outer key: compositeKey(name, kind), inner key: version label
  const store = new Map<string, Map<string, VersionEntry>>();
  const listeners = new Set<(event: VersionChangeEvent) => void>();
  let lastTimestamp = 0; // let: monotonic counter to guarantee ordering

  /** Returns a monotonically increasing timestamp to guarantee ordering. */
  function nextTimestamp(): number {
    const now = Date.now();
    lastTimestamp = now > lastTimestamp ? now : lastTimestamp + 1;
    return lastTimestamp;
  }

  function notifyListeners(event: VersionChangeEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  function getOrCreateBucket(key: string): Map<string, VersionEntry> {
    const existing = store.get(key);
    if (existing !== undefined) return existing;
    const bucket = new Map<string, VersionEntry>();
    store.set(key, bucket);
    return bucket;
  }

  // -------------------------------------------------------------------------
  // Reader
  // -------------------------------------------------------------------------

  const resolve = (
    name: string,
    kind: BrickKind,
    version: string,
  ): Result<VersionEntry, KoiError> => {
    const bucket = store.get(compositeKey(name, kind));
    if (bucket === undefined) {
      return { ok: false, error: notFound(`${kind}:${name}@${version}`) };
    }
    const entry = bucket.get(version);
    if (entry === undefined) {
      return { ok: false, error: notFound(`${kind}:${name}@${version}`) };
    }
    return { ok: true, value: entry };
  };

  const resolveLatest = (name: string, kind: BrickKind): Result<VersionEntry, KoiError> => {
    const bucket = store.get(compositeKey(name, kind));
    if (bucket === undefined || bucket.size === 0) {
      return { ok: false, error: notFound(`${kind}:${name}`, "No versions found") };
    }

    // Find entry with highest publishedAt
    let latest: VersionEntry | undefined; // let: iterative max-search
    for (const entry of bucket.values()) {
      if (latest === undefined || entry.publishedAt > latest.publishedAt) {
        latest = entry;
      }
    }

    if (latest === undefined) {
      return { ok: false, error: notFound(`${kind}:${name}`, "No versions found") };
    }
    return { ok: true, value: latest };
  };

  const listVersions = (
    name: string,
    kind: BrickKind,
  ): Result<readonly VersionEntry[], KoiError> => {
    const bucket = store.get(compositeKey(name, kind));
    if (bucket === undefined || bucket.size === 0) {
      return { ok: false, error: notFound(`${kind}:${name}`, "No versions found") };
    }

    // Sort by publishedAt descending (newest first)
    const sorted = [...bucket.values()].sort((a, b) => b.publishedAt - a.publishedAt);
    return { ok: true, value: sorted };
  };

  const onChange = (listener: (event: VersionChangeEvent) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  // -------------------------------------------------------------------------
  // Writer
  // -------------------------------------------------------------------------

  const publish = (
    name: string,
    kind: BrickKind,
    version: string,
    brickId: BrickId,
    publisher: PublisherId,
  ): Result<VersionEntry, KoiError> => {
    if (name.trim() === "") {
      return { ok: false, error: validation("Brick name must not be empty") };
    }
    if (version.trim() === "") {
      return { ok: false, error: validation("Version must not be empty") };
    }

    const key = compositeKey(name, kind);
    const bucket = getOrCreateBucket(key);
    const existing = bucket.get(version);

    if (existing !== undefined) {
      // Idempotent for same tuple
      if (existing.brickId === brickId) {
        return { ok: true, value: existing };
      }
      // CONFLICT: same label, different content hash
      return {
        ok: false,
        error: conflict(
          `${kind}:${name}@${version}`,
          `Version "${version}" already maps to BrickId "${existing.brickId}", cannot re-bind to "${brickId}"`,
        ),
      };
    }

    const entry: VersionEntry = {
      version,
      brickId,
      publisher,
      publishedAt: nextTimestamp(),
    };

    bucket.set(version, entry);
    notifyListeners({ kind: "published", brickKind: kind, name, version, brickId, publisher });
    return { ok: true, value: entry };
  };

  const deprecate = (name: string, kind: BrickKind, version: string): Result<void, KoiError> => {
    const bucket = store.get(compositeKey(name, kind));
    if (bucket === undefined) {
      return { ok: false, error: notFound(`${kind}:${name}@${version}`) };
    }
    const entry = bucket.get(version);
    if (entry === undefined) {
      return { ok: false, error: notFound(`${kind}:${name}@${version}`) };
    }

    // Idempotent — set deprecated flag, only fire event on first deprecation
    if (entry.deprecated !== true) {
      const updated: VersionEntry = { ...entry, deprecated: true };
      bucket.set(version, updated);
      notifyListeners({
        kind: "deprecated",
        brickKind: kind,
        name,
        version,
        brickId: entry.brickId,
        publisher: entry.publisher,
      });
    }
    return { ok: true, value: undefined };
  };

  const yank = (name: string, kind: BrickKind, version: string): Result<void, KoiError> => {
    const bucket = store.get(compositeKey(name, kind));
    if (bucket === undefined) {
      return { ok: false, error: notFound(`${kind}:${name}@${version}`) };
    }
    const entry = bucket.get(version);
    if (entry === undefined) {
      return { ok: false, error: notFound(`${kind}:${name}@${version}`) };
    }

    bucket.delete(version);
    notifyListeners({
      kind: "yanked",
      brickKind: kind,
      name,
      version,
      brickId: entry.brickId,
      publisher: entry.publisher,
    });
    return { ok: true, value: undefined };
  };

  return {
    resolve,
    resolveLatest,
    listVersions,
    onChange,
    publish,
    deprecate,
    yank,
  };
}
