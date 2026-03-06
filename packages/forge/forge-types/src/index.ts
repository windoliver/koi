/**
 * @koi/forge-types — Shared types, errors, config, and interfaces for the forge subsystem.
 *
 * L0-utility package: depends on @koi/core and @koi/validation only.
 * Imported by all @koi/forge-* sub-packages.
 */

// config — ForgeConfig, sub-configs, validation, factory
export type {
  DependencyConfig,
  ForgeConfig,
  FormatConfig,
  MutationPressureConfig,
  ScopePromotionConfig,
  VerificationConfig,
} from "./config.js";
export { createDefaultForgeConfig, validateForgeConfig } from "./config.js";
// errors — ForgeError discriminated union + factory functions
export type { ForgeError, TestFailure } from "./errors.js";
export {
  delegationError,
  formatError,
  governanceError,
  resolveError,
  sandboxError,
  selfTestError,
  staticError,
  storeError,
  trustError,
  typeError,
} from "./errors.js";
// forge defaults — shared constants
export {
  DEFAULT_ATTESTATION_CACHE_CAP,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  MAX_EXTERNAL_LISTENERS,
} from "./forge-defaults.js";
// pipeline — DI interface for cross-package operations
export type { BrickContentInput, CreateProvenanceOptions, ForgePipeline } from "./pipeline.js";
// reverification — TTL computation and staleness
export type { ReverificationConfig } from "./reverification.js";
export { computeTtl, DEFAULT_REVERIFICATION_CONFIG, isStale } from "./reverification.js";
// scope filter — visibility functions
export { filterByAgentScope, isVisibleToAgent } from "./scope-filter.js";
// types — forge inputs, outputs, verification, context
export type {
  AgentArtifact,
  BrickArtifact,
  BrickArtifactBase,
  BrickKind,
  BrickLifecycle,
  BrickRequires,
  CompositeArtifact,
  DriftChecker,
  DriftCheckResult,
  ForgeAgentInput,
  ForgeAgentInputWithBricks,
  ForgeAgentInputWithManifest,
  ForgeChannelInput,
  ForgeCompositeInput,
  ForgeContext,
  ForgeInput,
  ForgeInputBase,
  ForgeMiddlewareInput,
  ForgeQuery,
  ForgeResult,
  ForgeResultMetadata,
  ForgeScope,
  ForgeSkillInput,
  ForgeToolInput,
  ForgeVerifier,
  GovernanceResult,
  ImplementationArtifact,
  ManifestParseResult,
  ManifestParser,
  PromoteChange,
  PromoteResult,
  ResolveStageReport,
  SandboxError,
  SandboxErrorCode,
  SandboxExecutor,
  SandboxResult,
  SelfTestStageReport,
  SkillArtifact,
  StageReport,
  TestCase,
  ToolArtifact,
  TrustStageReport,
  VerificationReport,
  VerificationStage,
  VerifierResult,
} from "./types.js";
