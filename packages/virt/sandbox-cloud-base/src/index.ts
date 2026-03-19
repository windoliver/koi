/**
 * @koi/sandbox-cloud-base — Shared utilities for cloud sandbox adapters (L0u)
 *
 * Provides: instance guard, cached bridge, error classification, output truncation,
 * cloud adapter factory, and test fixtures for all cloud sandbox backends.
 */

// Bridge — SandboxAdapter → SandboxExecutor with TTL keep-alive
export type { BridgeConfig, CachedExecutor } from "./bridge.js";
export { createCachedBridge } from "./bridge.js";
// Error classification — cloud errors → SandboxErrorCode
export type { ClassifiedError } from "./classify-error.js";
export { classifyCloudError } from "./classify-error.js";
// Cloud adapter factory — generic scaffolding for cloud sandbox adapters
export type { CloudAdapterSpec } from "./cloud-adapter.js";
export { createCloudAdapter } from "./cloud-adapter.js";

// Cloud instance factory — shared exec/readFile/writeFile/destroy
export type {
  CloudInstanceConfig,
  CloudSdkProcessHandle,
  CloudSdkSandbox,
} from "./cloud-instance.js";
export { createCloudInstance } from "./cloud-instance.js";

// Instance guard — prevents method calls after detach/destroy (tri-state)
export type { DestroyGuard, InstanceGuard } from "./guard.js";
export { createDestroyGuard, createInstanceGuard } from "./guard.js";
// Line reader — NDJSON-over-pipe with backpressure caps
export type { LineReaderOptions } from "./line-reader.js";
export {
  createLineReader,
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
} from "./line-reader.js";
// Nexus FUSE mount — post-creation Nexus VFS mounting
export { mountNexusFuse } from "./nexus-mount.js";

// Sandbox admin — persistent sandbox listing and GC contract
export type { PersistentSandboxInfo, SandboxAdmin } from "./sandbox-admin.js";

// Shell escaping — safe command interpolation for cloud SDKs
export { shellEscape, shellJoin } from "./shell-escape.js";
// Test fixtures — shared profiles and streaming helpers
export { createTestProfile } from "./test-profiles.js";
export type { StreamCollector } from "./test-streaming.js";
export { createStreamCollector } from "./test-streaming.js";

// Output truncation — byte-limited accumulator
export type { OutputAccumulator } from "./truncate.js";
export { createOutputAccumulator, DEFAULT_MAX_OUTPUT_BYTES } from "./truncate.js";

// Profile validation — detect unsupported policies for cloud adapters
export type { UnsupportedProfileFields } from "./validate-profile.js";
export {
  detectUnsupportedProfileFields,
  formatUnsupportedProfileError,
} from "./validate-profile.js";
