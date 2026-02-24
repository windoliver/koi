/**
 * Span context store — closure-based Map wrapper with max-size eviction.
 *
 * Stores active OTel spans keyed by session/turn identifiers.
 * When the store exceeds `maxSize`, the oldest entry (by insertion order) is evicted.
 */

import type { Span } from "@opentelemetry/api";

const DEFAULT_MAX_SIZE = 1000;

export interface SpanContextStore {
  readonly set: (key: string, span: Span) => void;
  readonly get: (key: string) => Span | undefined;
  readonly delete: (key: string) => boolean;
  readonly size: () => number;
}

export function createSpanContextStore(maxSize: number = DEFAULT_MAX_SIZE): SpanContextStore {
  const map = new Map<string, Span>();

  const set = (key: string, span: Span): void => {
    // Delete first so re-insertion moves the key to the end (newest)
    map.delete(key);
    map.set(key, span);

    if (map.size > maxSize) {
      // Evict oldest entry (first key in iteration order) and end its span
      const oldest = map.entries().next();
      if (!oldest.done) {
        const [oldestKey, evictedSpan] = oldest.value;
        evictedSpan.end();
        map.delete(oldestKey);
      }
    }
  };

  const get = (key: string): Span | undefined => map.get(key);

  const del = (key: string): boolean => map.delete(key);

  const size = (): number => map.size;

  return { set, get, delete: del, size };
}
