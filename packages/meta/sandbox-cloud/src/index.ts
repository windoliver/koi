/**
 * @koi/sandbox-cloud — Cloud sandbox provider dispatch (Layer 3)
 *
 * Single import for any cloud sandbox provider.
 * Use createCloudSandbox({ provider: "e2b", ... }) or import provider factories directly.
 */

export type {
  BridgeConfig,
  CachedExecutor,
  ClassifiedError,
  CloudInstanceConfig,
  CloudSdkSandbox,
} from "@koi/sandbox-cloud-base";
// ── Shared cloud base utilities ─────────────────────────────────────────
export {
  classifyCloudError,
  createCachedBridge,
  createCloudInstance,
} from "@koi/sandbox-cloud-base";
// ── Provider config types ───────────────────────────────────────────────
export type { CloudflareAdapterConfig } from "@koi/sandbox-cloudflare";
// ── Provider factories (direct access) ──────────────────────────────────
export { createCloudflareAdapter } from "@koi/sandbox-cloudflare";
export type { DaytonaAdapterConfig } from "@koi/sandbox-daytona";
export { createDaytonaAdapter } from "@koi/sandbox-daytona";
export type { E2bAdapterConfig } from "@koi/sandbox-e2b";
export { createE2bAdapter } from "@koi/sandbox-e2b";
export type { VercelAdapterConfig } from "@koi/sandbox-vercel";
export { createVercelAdapter } from "@koi/sandbox-vercel";
// ── Dispatcher factory ──────────────────────────────────────────────────
export { createCloudSandbox } from "./create-cloud-sandbox.js";
// ── Config union type ───────────────────────────────────────────────────
export type { CloudSandboxConfig, CloudSandboxProvider } from "./types.js";
