/**
 * @koi/sandbox-cloudflare — Cloudflare cloud sandbox adapter (Layer 2)
 *
 * Provides Cloudflare sandbox instances with optional R2 FUSE mount support.
 */

export { createCloudflareAdapter } from "./adapter.js";
export { createCloudflareInstance } from "./instance.js";
export type {
  CfCreateOpts,
  CfSdkSandbox,
  CloudflareAdapterConfig,
  CloudflareClient,
  CloudflareR2Mount,
} from "./types.js";
export type { ValidatedCloudflareConfig } from "./validate.js";
export { validateCloudflareConfig } from "./validate.js";
