/** Configuration for the Nexus-backed ACE stores. */

import type { NexusTransport } from "@koi/nexus-client";

export interface NexusPlaybookStoreConfig {
  /** A configured Nexus transport. */
  readonly transport: NexusTransport;
  /** Base path for all ACE files. Default: "ace". */
  readonly basePath?: string;
}
