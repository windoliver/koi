/**
 * @koi/sandbox-e2b — E2B cloud sandbox adapter (Layer 2)
 *
 * Provides E2B (https://e2b.dev) cloud sandbox instances for remote
 * code execution in Firecracker microVMs.
 */

export { createE2bAdapter } from "./adapter.js";
export { createE2bInstance } from "./instance.js";
export type {
  E2bAdapterConfig,
  E2bBucketMount,
  E2bClient,
  E2bCreateOpts,
  E2bSdkSandbox,
} from "./types.js";
export type { ValidatedE2bConfig } from "./validate.js";
export { validateE2bConfig } from "./validate.js";
