/**
 * @koi/sandbox-stack — Unified L3 bundle for sandboxed code execution.
 *
 * Cloud dispatch, stack composition, timeout guards, and middleware.
 *
 * One import for everything sandbox: cloud provider dispatch, adapter factories,
 * code execution tools, subprocess executors, and sandbox middleware.
 */

// ── Code executor ───────────────────────────────────────────────────────
export type { ConsoleEntry, ScriptConfig, ScriptResult } from "@koi/code-executor";
export {
  createCodeExecutorProvider,
  createExecuteScriptTool,
  executeScript,
} from "@koi/code-executor";
// ── Sandbox middleware ──────────────────────────────────────────────────
export type { SandboxMiddlewareConfig } from "@koi/middleware-sandbox";
export {
  createSandboxMiddleware,
  DEFAULT_OUTPUT_LIMIT_BYTES,
  DEFAULT_TIMEOUT_GRACE_MS,
  descriptor as sandboxMiddlewareDescriptor,
  validateConfig as validateSandboxMiddlewareConfig,
} from "@koi/middleware-sandbox";
// ── Cloud-base utilities ────────────────────────────────────────────────
export type {
  BridgeConfig,
  CachedExecutor,
  ClassifiedError,
  CloudInstanceConfig,
  CloudSdkSandbox,
} from "@koi/sandbox-cloud-base";
export {
  classifyCloudError,
  createCachedBridge,
  createCloudInstance,
} from "@koi/sandbox-cloud-base";
// ── Cloud adapter shims (lazy-loaded — install the provider package to use) ──
export type { CloudflareAdapterConfig } from "@koi/sandbox-cloudflare";
export type { DaytonaAdapterConfig } from "@koi/sandbox-daytona";
export type { DockerAdapterConfig } from "@koi/sandbox-docker";
export type { E2bAdapterConfig } from "@koi/sandbox-e2b";
// ── Sandbox executor ────────────────────────────────────────────────────
export type { SandboxPlatform } from "@koi/sandbox-executor";
export {
  createPromotedExecutor,
  createSubprocessExecutor,
  detectSandboxPlatform,
} from "@koi/sandbox-executor";
export type { VercelAdapterConfig } from "@koi/sandbox-vercel";
export { createCloudflareAdapterShim as createCloudflareAdapter } from "./adapters/cloudflare.js";
export { createDaytonaAdapterShim as createDaytonaAdapter } from "./adapters/daytona.js";
export { createDockerAdapterShim as createDockerAdapter } from "./adapters/docker.js";
export { createE2bAdapterShim as createE2bAdapter } from "./adapters/e2b.js";
export { createVercelAdapterShim as createVercelAdapter } from "./adapters/vercel.js";
export type { CloudSandboxConfig, CloudSandboxProvider } from "./cloud-types.js";
// ── Cloud dispatch ──────────────────────────────────────────────────────
export { createCloudSandbox } from "./create-cloud-sandbox.js";
// ── Stack composition (original sandbox-stack) ──────────────────────────
export { createSandboxStack } from "./create-sandbox-stack.js";
export type { ExecuteCodeProviderOptions } from "./execute-code-tool.js";
export { createExecuteCodeProvider } from "./execute-code-tool.js";
export { createTimeoutGuardedExecutor } from "./timeout-guard.js";
export type { SandboxStack, SandboxStackConfig } from "./types.js";
