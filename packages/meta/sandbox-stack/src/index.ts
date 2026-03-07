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
// ── Adapter factories + config types ────────────────────────────────────
export type { CloudflareAdapterConfig } from "@koi/sandbox-cloudflare";
export { createCloudflareAdapter } from "@koi/sandbox-cloudflare";
export type { DaytonaAdapterConfig } from "@koi/sandbox-daytona";
export { createDaytonaAdapter } from "@koi/sandbox-daytona";
export type { DockerAdapterConfig } from "@koi/sandbox-docker";
export { createDockerAdapter } from "@koi/sandbox-docker";
export type { E2bAdapterConfig } from "@koi/sandbox-e2b";
export { createE2bAdapter } from "@koi/sandbox-e2b";
// ── Sandbox executor ────────────────────────────────────────────────────
export type { SandboxPlatform } from "@koi/sandbox-executor";
export {
  createPromotedExecutor,
  createSubprocessExecutor,
  detectSandboxPlatform,
} from "@koi/sandbox-executor";
export type { VercelAdapterConfig } from "@koi/sandbox-vercel";
export { createVercelAdapter } from "@koi/sandbox-vercel";
export type { CloudSandboxConfig, CloudSandboxProvider } from "./cloud-types.js";
// ── Cloud dispatch ──────────────────────────────────────────────────────
export { createCloudSandbox } from "./create-cloud-sandbox.js";
// ── Stack composition (original sandbox-stack) ──────────────────────────
export { createSandboxStack } from "./create-sandbox-stack.js";
export type { ExecuteCodeProviderOptions } from "./execute-code-tool.js";
export { createExecuteCodeProvider } from "./execute-code-tool.js";
export { createTimeoutGuardedExecutor } from "./timeout-guard.js";
export type { SandboxStack, SandboxStackConfig } from "./types.js";
