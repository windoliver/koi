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

  // Mount mutation/inspection methods (addMount, removeMount, listMounts,
  // describeMount) are deliberately NOT exposed on the HTTP transport.
  // The local-bridge path goes through resolveFileSystemAsync which wraps
  // the transport with overlap, protected-root, scope, read-only, and
  // quarantine guards (see resolve-filesystem.ts:guardedTransport). The
  // HTTP path returns transport: undefined from resolveFileSystemAsync,
  // so the runtime never reaches a mutation API for HTTP sessions today.
  // Adding raw RPC pass-throughs here would create a second mutation
  // surface that bypasses every safety invariant the local-bridge path
  // enforces — read-only/scoped sessions could mutate topology against
  // the server regardless of the runtime's policy. If a future feature
  // needs HTTP mount mutations, they must be wrapped with the same
  // guarded-transport policy as the local-bridge path.
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
