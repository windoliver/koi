/**
 * @koi/forge — Self-extension system (Layer 3 bundle)
 *
 * Re-exports from @koi/forge-types, @koi/forge-integrity, @koi/forge-policy,
 * @koi/forge-verifier, and @koi/forge-tools. Plus the L3-only composition root
 * (createForgePipeline, createForgeRuntime).
 *
 * Backward-compatible: all prior exports are preserved via sub-package re-exports.
 */

// ---------------------------------------------------------------------------
// L0 re-exports (types from @koi/core, for backward compatibility)
// ---------------------------------------------------------------------------

export type {
  AdvisoryLock,
  AgentArtifact,
  BrickArtifact,
  BrickArtifactBase,
  BrickRequires,
  BrickUpdate,
  ContentMarker,
  CounterExample,
  DataClassification,
  ForgeAttestationSignature,
  ForgeBuildDefinition,
  ForgeBuilder,
  ForgeProvenance,
  ForgeQuery,
  ForgeResourceRef,
  ForgeRunMetadata,
  ForgeStageDigest,
  ForgeStore,
  ForgeVerificationSummary,
  LockHandle,
  LockMode,
  LockRequest,
  SigningBackend,
  SkillArtifact,
  StoreChangeEvent,
  StoreChangeKind,
  StoreChangeNotifier,
  TestCase,
  ToolArtifact,
} from "@koi/core";

// ---------------------------------------------------------------------------
// @koi/forge-types (L0u) — shared types, errors, config
// ---------------------------------------------------------------------------

export type {
  BrickContentInput,
  CreateProvenanceOptions,
  DependencyConfig,
  DriftChecker,
  DriftCheckResult,
  ForgeAgentInput,
  ForgeAgentInputWithBricks,
  ForgeAgentInputWithManifest,
  ForgeChannelInput,
  ForgeConfig,
  ForgeContext,
  ForgeError,
  ForgeInput,
  ForgeInputBase,
  ForgeMiddlewareInput,
  ForgePipeline,
  ForgeResult,
  ForgeResultMetadata,
  ForgeSkillInput,
  ForgeToolInput,
  ForgeVerifier,
  FormatConfig,
  GovernanceResult,
  ManifestParseResult,
  ManifestParser,
  MutationPressureConfig,
  PromoteChange,
  PromoteResult,
  ResolveStageReport,
  ReverificationConfig,
  SandboxError,
  SandboxErrorCode,
  SandboxExecutor,
  SandboxResult,
  ScopePromotionConfig,
  SelfTestStageReport,
  StageReport,
  TestFailure,
  TrustStageReport,
  VerificationConfig,
  VerificationReport,
  VerificationStage,
  VerifierResult,
} from "@koi/forge-types";

export {
  computeTtl,
  createDefaultForgeConfig,
  DEFAULT_REVERIFICATION_CONFIG,
  delegationError,
  filterByAgentScope,
  formatError,
  governanceError,
  isStale,
  isVisibleToAgent,
  resolveError,
  sandboxError,
  selfTestError,
  staticError,
  storeError,
  trustError,
  typeError,
  validateForgeConfig,
} from "@koi/forge-types";

// ---------------------------------------------------------------------------
// @koi/forge-integrity (L2) — attestation, integrity, SLSA
// ---------------------------------------------------------------------------

export type {
  AttestationCache,
  IntegrityAttestationFailed,
  IntegrityContentMismatch,
  IntegrityOk,
  IntegrityResult,
  SlsaBuildDefinition,
  SlsaBuilder,
  SlsaBuildMetadata,
  SlsaKoiExtensions,
  SlsaProvenanceV1,
  SlsaProvenanceV1WithExtensions,
  SlsaResourceDescriptor,
  SlsaRunDetails,
} from "@koi/forge-integrity";

export {
  canonicalJsonSerialize,
  createAttestationCache,
  createForgeProvenance,
  extractBrickContent,
  loadAndVerify,
  mapProvenanceToSlsa,
  mapProvenanceToStatement,
  signAttestation,
  verifyAttestation,
  verifyBrickAttestation,
  verifyBrickIntegrity,
} from "@koi/forge-integrity";

// ---------------------------------------------------------------------------
// @koi/forge-policy (L2) — governance, usage, drift, mutation pressure
// ---------------------------------------------------------------------------

export type {
  DriftCheckerConfig,
  ForgeSessionCounterInstance,
  ForgeSessionCounterOptions,
  ForgeUsageMiddlewareConfig,
  ReverificationHandler,
  ReverificationQueue,
  UsageRecordedResult,
  UsageResult,
} from "@koi/forge-policy";

export {
  checkGovernance,
  checkMutationPressure,
  checkScopePromotion,
  createDriftChecker,
  createForgeGovernanceContributor,
  createForgeSessionCounter,
  createForgeUsageMiddleware,
  createReverificationQueue,
  FORGE_GOVERNANCE,
  recordBrickUsage,
  validatePolicyChange,
} from "@koi/forge-policy";

// ---------------------------------------------------------------------------
// @koi/forge-verifier (L2) — verification pipeline, workspace, adversarial
// ---------------------------------------------------------------------------

export type {
  BrickModulePath,
  CodeSnippet,
  DiagnosticVerifierConfig,
  EnrichedSandboxError,
  FormatStageReport,
  GenerateTestCasesConfig,
  ScanFinding,
  ScanResult,
  WorkspaceResult,
} from "@koi/forge-verifier";

export {
  assignTrust,
  auditDependencies,
  auditTransitiveDependencies,
  cleanupOrphanedModules,
  cleanupStaleWorkspaces,
  compileBrickModule,
  computeDependencyHash,
  computeRemediation,
  createAdversarialVerifiers,
  createBrickWorkspace,
  createContentScanningVerifier,
  createDiagnosticVerifier,
  createExfiltrationVerifier,
  createInjectionVerifier,
  createResourceExhaustionVerifier,
  createStructuralHidingVerifier,
  enrichSandboxError,
  extractSnippet,
  generateTestCases,
  resolveWorkspacePath,
  sanitizeInput,
  scanWorkspaceCode,
  verify,
  verifyFormat,
  verifyInstallIntegrity,
  verifyResolve,
  verifySandbox,
  verifySelfTest,
  verifyStatic,
  writeBrickEntry,
} from "@koi/forge-verifier";

// ---------------------------------------------------------------------------
// @koi/forge-tools (L2) — primordial tools, component provider, resolver
// ---------------------------------------------------------------------------

export type {
  AssembleManifestOptions,
  AssembleManifestResult,
  DelegateOptions,
  ForgeComponentProviderConfig,
  ForgeComponentProviderInstance,
  ForgeDeps,
  ForgeRegistrySyncConfig,
  ForgeResolverContext,
  ForgeSpawnData,
  ForgeToolConfig,
  NetworkPolicy,
  OnForgeAgentSpawn,
  RequiresCheckResult,
  SkillMdInput,
} from "@koi/forge-tools";

export {
  assembleManifest,
  brickToTool,
  checkBrickRequires,
  createComposeForge,
  createForgeAgentTool,
  createForgeChannelTool,
  createForgeComponentProvider,
  createForgeEditTool,
  createForgeMiddlewareTool,
  createForgeRegistrySync,
  createForgeResolver,
  createForgeSkillTool,
  createForgeTool,
  createForgeToolTool,
  createInMemoryForgeStore,
  createMemoryStoreChangeNotifier,
  createPromoteForgeTool,
  createSearchForgeTool,
  delegateImplementation,
  descriptor,
  generateDelegationPrompt,
  generateSkillMd,
  mapParsedBaseFields,
  mapParsedTestCases,
} from "@koi/forge-tools";

// ---------------------------------------------------------------------------
// @koi/forge-demand (L2) — demand-triggered forge detection
// ---------------------------------------------------------------------------

export type {
  ConfidenceWeights,
  FeedbackLoopHealthHandle,
  ForgeDemandConfig,
  ForgeDemandHandle,
  HeuristicThresholds,
} from "@koi/forge-demand";
export {
  createDefaultForgeDemandConfig,
  createForgeDemandDetector,
  DEFAULT_CAPABILITY_GAP_PATTERNS,
  DEFAULT_FORGE_DEMAND_CONFIG,
  validateForgeDemandConfig,
} from "@koi/forge-demand";

// ---------------------------------------------------------------------------
// @koi/forge-exaptation (L2) — purpose drift detection
// ---------------------------------------------------------------------------

export type {
  ExaptationConfig,
  ExaptationHandle,
  ExaptationThresholds,
} from "@koi/forge-exaptation";
export {
  computeExaptationConfidence,
  computeJaccardDistance,
  createDefaultExaptationConfig,
  createExaptationDetector,
  DEFAULT_EXAPTATION_CONFIG,
  detectPurposeDrift,
  tokenize,
  truncateToWords,
  validateExaptationConfig,
} from "@koi/forge-exaptation";

// ---------------------------------------------------------------------------
// @koi/forge-optimizer (L2) — statistical brick optimization
// ---------------------------------------------------------------------------

export type {
  BrickOptimizer,
  OptimizationConfig,
  OptimizationResult,
  OptimizerMiddlewareConfig,
} from "@koi/forge-optimizer";
export {
  computeFitnessScore,
  createBrickOptimizer,
  createOptimizerMiddleware,
} from "@koi/forge-optimizer";

// ---------------------------------------------------------------------------
// @koi/crystallize (L0u) — pattern detection and auto-forge
// ---------------------------------------------------------------------------

export type {
  AutoForgeConfig,
  AutoForgeVerifier,
  AutoForgeVerifierResult,
  CrystallizationCandidate,
  CrystallizeConfig,
  CrystallizeHandle,
  ToolNgram,
  ToolStep,
} from "@koi/crystallize";
export {
  createAutoForgeMiddleware,
  createCrystallizeMiddleware,
} from "@koi/crystallize";

// ---------------------------------------------------------------------------
// L3-only: composition root + runtime
// ---------------------------------------------------------------------------

export type {
  ForgeConfiguredKoiOptions,
  ForgeConfiguredKoiResult,
} from "./configured-koi.js";
export { createForgeConfiguredKoi } from "./configured-koi.js";
export type { ForgeDelegation, ForgeDelegationConfig } from "./create-forge-delegation.js";
export { createForgeDelegation } from "./create-forge-delegation.js";
export type {
  ForgeMiddlewareStackConfig,
  ForgeMiddlewareStackResult,
} from "./create-forge-middleware-stack.js";
export { createForgeMiddlewareStack } from "./create-forge-middleware-stack.js";
export { createForgePipeline } from "./create-forge-stack.js";
export type { ForgeToolsProviderConfig } from "./create-forge-tools-provider.js";
export { createForgeToolsProvider } from "./create-forge-tools-provider.js";
export type { CreateFullForgeSystemConfig, FullForgeSystem } from "./create-full-forge-system.js";
export { createFullForgeSystem } from "./create-full-forge-system.js";
export type { ForgeBootstrapConfig, ForgeBootstrapResult } from "./forge-bootstrap.js";
export { createForgeBootstrap } from "./forge-bootstrap.js";
export { FORGE_COMPANION_SKILL } from "./forge-companion-skill.js";
export type { CreateForgeRuntimeOptions, ForgeRuntimeInstance } from "./forge-runtime.js";
export { createForgeRuntime } from "./forge-runtime.js";
