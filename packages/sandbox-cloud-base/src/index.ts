/**
 * @koi/sandbox-cloud-base — Shared utilities for cloud sandbox adapters (L0u)
 *
 * Provides: destroy guard, cached bridge, error classification, output truncation,
 * and test fixtures for all cloud sandbox backends.
 */

// Bridge — SandboxAdapter → SandboxExecutor with TTL keep-alive
export type { BridgeConfig, CachedExecutor } from "./bridge.js";
export { createCachedBridge } from "./bridge.js";

// Error classification — cloud errors → SandboxErrorCode
export type { ClassifiedError } from "./classify-error.js";
export { classifyCloudError } from "./classify-error.js";

// Destroy guard — prevents method calls after destroy()
export type { DestroyGuard } from "./guard.js";
export { createDestroyGuard } from "./guard.js";
// Nexus FUSE mount — post-creation Nexus VFS mounting
export { mountNexusFuse } from "./nexus-mount.js";
// Test fixtures — shared profiles and streaming helpers
export { createTestProfile } from "./test-profiles.js";
export type { StreamCollector } from "./test-streaming.js";
export { createStreamCollector } from "./test-streaming.js";

// Output truncation — byte-limited accumulator
export type { OutputAccumulator } from "./truncate.js";
export { createOutputAccumulator } from "./truncate.js";
