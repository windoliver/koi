/**
 * Configuration for `createSnapshotStoreNexus`.
 *
 * The store is generic over the payload type `T`. Snapshots are written as
 * JSON files at `<basePath>/<chainId>/<nodeId>.json`.
 */

import type { NexusTransport } from "@koi/nexus-client";

export interface NexusSnapshotStoreConfig {
  /** A configured Nexus transport (HTTP, local-bridge, or test fake). */
  readonly transport: NexusTransport;

  /**
   * Base path within the Nexus mount where chains are stored.
   * Defaults to `"snapshots"`. Must not contain `..`, `\`, or null bytes.
   */
  readonly basePath?: string;
}
