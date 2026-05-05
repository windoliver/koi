/** Configuration for the Nexus-backed ACE stores. */

import type { NexusTransport } from "@koi/nexus-client";

export interface NexusPlaybookStoreConfig {
  /** A configured Nexus transport. */
  readonly transport: NexusTransport;
  /** Base path for all ACE files. Default: "ace". */
  readonly basePath?: string;

  /**
   * Explicit lock-scope key used to key the module-level lock registries in
   * `playbook-locks.ts` and `proposal-locks.ts`.
   *
   * Two store instances that point at the **same Nexus backend** (even via
   * different transport objects — e.g. decorator wrappers, separate HTTP
   * clients to the same URL) MUST set the same `lockScope` string so they
   * share a single in-process lock pool. Without this, each transport object
   * gets its own pool and concurrent writes can race.
   *
   * **Default (safe for single-basePath deployments):** falls back to
   * `basePath` (or `"ace"` if basePath is also omitted). The default is
   * safe only when the application has a single basePath per backend and
   * always uses the same transport instance or wrapper chain. If you create
   * multiple stores over the same backend with wrapper transports, you MUST
   * supply an explicit `lockScope`.
   */
  readonly lockScope?: string;
}
