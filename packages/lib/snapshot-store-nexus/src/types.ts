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

  /**
   * Explicit lock-scope key used to key the module-level lock registry.
   *
   * Two store instances that point at the **same Nexus backend** (even via
   * different transport objects — e.g. decorator wrappers, separate HTTP
   * clients to the same URL) MUST set the same `lockScope` string so they
   * share a single in-process lock pool. Without this, each transport object
   * gets its own pool and concurrent writes can race and corrupt meta.
   *
   * **Default (safe for single-basePath deployments):** falls back to
   * `basePath` (or `"snapshots"` if basePath is also omitted). The default
   * is safe only when the application has a single basePath per backend and
   * always uses the same transport instance or wrapper chain. If you create
   * multiple stores over the same backend with wrapper transports, you MUST
   * supply an explicit `lockScope`.
   */
  readonly lockScope?: string;
}
