/**
 * Channel adapter registry — name → factory map.
 *
 * Provides a generic registry primitive that downstream meta-packages
 * (e.g. a future `@koi/channels`) populate with concrete adapter shims.
 * The registry takes a snapshot of its entries at construction time,
 * so callers can build a Map and reuse it without leaking mutability.
 */

import type { ChannelAdapter } from "@koi/core";

/**
 * Builds a `ChannelAdapter` from a JSON-serializable config object.
 * Each adapter package exports its own factory; the registry stores them by name.
 */
export type ChannelFactory = (config: unknown) => ChannelAdapter;

export interface ChannelRegistry {
  readonly get: (name: string) => ChannelFactory | undefined;
  readonly names: () => ReadonlySet<string>;
}

/**
 * Creates a `ChannelRegistry` from a name → factory map. Entries are copied,
 * so post-construction mutations to the input map do not affect the registry.
 */
export function createChannelRegistry(
  entries: ReadonlyMap<string, ChannelFactory>,
): ChannelRegistry {
  const snapshot = new Map(entries);
  return {
    get: (name) => snapshot.get(name),
    names: () => new Set(snapshot.keys()),
  };
}
