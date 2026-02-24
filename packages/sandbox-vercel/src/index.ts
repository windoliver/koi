/**
 * @koi/sandbox-vercel — Vercel cloud sandbox adapter (Layer 2)
 *
 * Provides Vercel Sandbox (Firecracker microVM) instances for remote code execution.
 */

export { createVercelAdapter } from "./adapter.js";
export { createVercelInstance } from "./instance.js";
export type {
  VercelAdapterConfig,
  VercelClient,
  VercelCreateOpts,
  VercelSdkSandbox,
} from "./types.js";
export type { ValidatedVercelConfig } from "./validate.js";
export { validateVercelConfig } from "./validate.js";
