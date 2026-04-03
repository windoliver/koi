/**
 * koi — Self-extending agent engine (Layer 4)
 *
 * Single-package distribution that absorbs all L3 meta-packages and orphaned L2 packages.
 * Default engine: pi (engine-pi).
 *
 * Root export provides: starter + engine + core types + manifest utilities.
 *
 * Usage:
 *   import { createKoi, createConfiguredKoi, loadManifest, getEngineName } from "koi";
 *   import { createChannelStack } from "koi/channels";
 *   import { createSandboxStack } from "koi/sandbox";
 */

// ── @koi/core — type-only re-exports ────────────────────────────────────
export type {
  Agent,
  AgentManifest,
  AgentStatus,
  ChannelAdapter,
  ComponentProvider,
  ContentBlock,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  EngineOutput,
  EngineState,
  JsonObject,
  KoiError,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  Result,
  SubsystemToken,
  ToolHandler,
} from "@koi/core";

// ── @koi/engine — runtime factory ───────────────────────────────────────
export { createKoi } from "@koi/engine";
export type { PiAdapterConfig } from "@koi/engine-pi";
// ── @koi/engine-pi — default engine ─────────────────────────────────────
export { createPiAdapter } from "@koi/engine-pi";
export type {
  DeployConfig,
  LoadedManifest,
  LoadResult,
  ManifestWarning,
} from "@koi/manifest";
// ── @koi/manifest — loading + engine name ───────────────────────────────
export { getEngineName, loadManifest, loadManifestFromString } from "@koi/manifest";
export type {
  BuiltinCallbacks,
  ConfiguredKoiOptions,
  LocalBackends,
  LocalBackendsConfig,
  MiddlewareFactory,
  MiddlewareRegistry,
  RuntimeOpts,
  ScopeBackends,
} from "@koi/starter";
// ── @koi/starter — configured factory + registry ────────────────────────
export {
  createConfiguredKoi,
  createDefaultRegistry,
  createLocalBackends,
  createMiddlewareRegistry,
  resolveManifestMiddleware,
  resolveManifestScope,
} from "@koi/starter";
