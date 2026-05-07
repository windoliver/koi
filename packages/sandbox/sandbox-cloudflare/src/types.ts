/**
 * Cloudflare adapter types — package-local config shape and host-side mapping.
 */

import type { EdgeIntegrityVerification } from "@koi/core";

/** Configuration accepted by `createCloudflareAdapter`. */
export interface CloudflareAdapterConfig {
  readonly accountId: string;
  readonly apiToken: string;
  /**
   * Fleet-namespacing prefix. Rejected as empty or `"default"` per spec
   * "All dedupe keys are fleet-namespaced".
   */
  readonly ownerId: string;
  /** Durable Object namespace ID; the DO class itself is shipped by this package. */
  readonly dedupeDurableObjectNamespaceId: string;
  /** Defaults to `"cached"` per spec § "Integrity verification". */
  readonly integrityVerification?: EdgeIntegrityVerification;
  /** Override default 1_000ms cached-mode skew window. */
  readonly cachedVerifyMaxAgeMs?: number;
  /** Override default 600_000ms persistent-poison threshold. */
  readonly staleVerifyBoundMs?: number;
}

/** Tagged outcome of decoding a shim HTTP response into a typed result. */
export type ShimResponseKind =
  | "success"
  | "failed-permanent"
  | "timeout"
  | "shim-error"
  | "operation-id-conflict"
  | "operation-expired"
  | "provider-error"
  | "malformed-shim-response";
