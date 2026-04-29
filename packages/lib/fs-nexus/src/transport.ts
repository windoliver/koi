/**
 * HTTP JSON-RPC transport for @koi/fs-nexus.
 * Delegates core HTTP logic to @koi/nexus-client and adds
 * the bridge-notification interface (no-ops for HTTP transport).
 */

import { createHttpTransport as createBaseTransport } from "@koi/nexus-client";
import type { NexusFileSystemConfig, NexusTransport } from "./types.js";

/** Create an HTTP JSON-RPC transport to a Nexus server. */
export function createHttpTransport(config: NexusFileSystemConfig): NexusTransport {
  const base = createBaseTransport({
    url: config.url,
    apiKey: config.apiKey,
    deadlineMs: config.deadlineMs,
    retries: config.retries,
  });

  return {
    kind: "http",
    call: base.call,
    health: base.health,
    close: base.close,
    // HTTP transport has no bridge subprocess — notifications are local-only.
    subscribe: (): (() => void) => (): void => {},
    submitAuthCode: (): void => {},
  };
}
