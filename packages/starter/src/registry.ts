/**
 * MiddlewareRegistry — maps middleware names to factory functions.
 *
 * Factories receive the manifest MiddlewareConfig (JSON-safe options)
 * plus optional RuntimeOpts for values only available at agent-creation
 * time (e.g. agentDepth derived from ProcessId).
 */

import type { KoiMiddleware, MiddlewareConfig } from "@koi/core";

/**
 * Runtime options passed to middleware factories during manifest resolution.
 * Contains information only available at agent-creation time, not in the manifest JSON.
 */
export interface RuntimeOpts {
  /** Current agent process-tree depth (0 = root copilot). Passed to depth-aware middleware. */
  readonly agentDepth?: number;
}

/** Factory function that instantiates a KoiMiddleware from a manifest MiddlewareConfig. */
export type MiddlewareFactory = (
  config: MiddlewareConfig,
  opts?: RuntimeOpts,
) => KoiMiddleware | Promise<KoiMiddleware>;

/** Registry that maps middleware names to their factory functions. */
export interface MiddlewareRegistry {
  /** Look up a factory by middleware name. Returns undefined if not registered. */
  readonly get: (name: string) => MiddlewareFactory | undefined;
  /** All registered middleware names. */
  readonly names: () => ReadonlySet<string>;
}

/** Create a MiddlewareRegistry from a name → factory map. */
export function createMiddlewareRegistry(
  entries: ReadonlyMap<string, MiddlewareFactory>,
): MiddlewareRegistry {
  return {
    get: (name) => entries.get(name),
    names: () => new Set(entries.keys()),
  };
}
