/**
 * Configuration for the Nexus-backed FileSystemBackend.
 */

import type { NexusClient } from "@koi/nexus-client";

export interface NexusFileSystemConfig {
  /** Nexus JSON-RPC client — injected. L3 creates and shares one instance. */
  readonly client: NexusClient;
  /** RPC path prefix for all filesystem operations. Default: "/fs". */
  readonly basePath?: string | undefined;
}
