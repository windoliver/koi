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
  AutoPromotionConfig,
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
  UsagePromotedResult,
  UsageRecordedResult,
  UsageResult,
} from "@koi/forge-policy";

export {
  checkGovernance,
  checkMutationPressure,
  checkScopePromotion,
  computeAutoPromotion,
  createDriftChecker,
  createForgeGovernanceContributor,
  createForgeSessionCounter,
  createForgeUsageMiddleware,
  createReverificationQueue,
  FORGE_GOVERNANCE,
  recordBrickUsage,
  validateTrustTransition,
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
// L3-only: composition root + runtime
// ---------------------------------------------------------------------------

export type { ForgeDelegation, ForgeDelegationConfig } from "./create-forge-delegation.js";
export { createForgeDelegation } from "./create-forge-delegation.js";
export { createForgePipeline } from "./create-forge-stack.js";
export type { CreateForgeRuntimeOptions, ForgeRuntimeInstance } from "./forge-runtime.js";
export { createForgeRuntime } from "./forge-runtime.js";
