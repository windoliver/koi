/**
 * @koi/forge — Self-extension system (Layer 2)
 *
 * Enables agents to create, discover, and compose tools, skills, and
 * sub-agents at runtime through a 4-stage verification pipeline.
 *
 * Depends on @koi/core only — never on L1 or peer L2 packages.
 */

// Advisory lock types (for persistent backends)
// types — brick artifacts & query from L0
export type {
  AdvisoryLock,
  AgentArtifact,
  BrickArtifact,
  BrickArtifactBase,
  BrickRequires,
  BrickUpdate,
  CompositeArtifact,
  ForgeQuery,
  ForgeStore,
  LockHandle,
  LockMode,
  LockRequest,
  SkillArtifact,
  StoreChangeEvent,
  StoreChangeKind,
  StoreChangeNotifier,
  TestCase,
  ToolArtifact,
} from "@koi/core";
// runtime values — adversarial verifiers
export {
  createAdversarialVerifiers,
  createContentScanningVerifier,
  createExfiltrationVerifier,
  createInjectionVerifier,
  createResourceExhaustionVerifier,
  createStructuralHidingVerifier,
} from "./adversarial-verifiers.js";
// runtime values — manifest assembly
export type { AssembleManifestOptions, AssembleManifestResult } from "./assemble-manifest.js";
export { assembleManifest } from "./assemble-manifest.js";
export type {
  AutoPromotionConfig,
  ForgeConfig,
  ScopePromotionConfig,
  VerificationConfig,
} from "./config.js";
// runtime values — config
export { createDefaultForgeConfig, validateForgeConfig } from "./config.js";
export type { ForgeError, TestFailure } from "./errors.js";
// runtime values — errors
export {
  governanceError,
  sandboxError,
  selfTestError,
  staticError,
  storeError,
  trustError,
  typeError,
} from "./errors.js";
// runtime values — component provider
export type {
  ForgeComponentProviderConfig,
  ForgeComponentProviderInstance,
} from "./forge-component-provider.js";
export { brickToTool, createForgeComponentProvider } from "./forge-component-provider.js";
export type { ForgeResolverContext } from "./forge-resolver.js";
export { createForgeResolver } from "./forge-resolver.js";
export type { CreateForgeRuntimeOptions, ForgeRuntimeInstance } from "./forge-runtime.js";
export { createForgeRuntime } from "./forge-runtime.js";
// runtime values — usage tracking middleware
export type { ForgeUsageMiddlewareConfig } from "./forge-usage-middleware.js";
export { createForgeUsageMiddleware } from "./forge-usage-middleware.js";
// runtime values — SKILL.md generation
export type { SkillMdInput } from "./generate-skill-md.js";
export { generateSkillMd } from "./generate-skill-md.js";
export type { GovernanceResult } from "./governance.js";
// runtime values — governance
export { checkGovernance, checkScopePromotion } from "./governance.js";
// runtime values — integrity verification
export type { IntegrityMismatch, IntegrityOk, IntegrityResult } from "./integrity.js";
export { loadAndVerify, verifyBrickIntegrity } from "./integrity.js";
// runtime values — storage
export { createInMemoryForgeStore } from "./memory-store.js";
export type { RequiresCheckResult } from "./requires-check.js";
export { checkBrickRequires } from "./requires-check.js";
export { filterByAgentScope, isVisibleToAgent } from "./scope-filter.js";
// runtime values — store change notification
export { createMemoryStoreChangeNotifier } from "./store-notifier.js";
export { createComposeForgeTool } from "./tools/compose-forge.js";
export type { OnForgeAgentSpawn } from "./tools/forge-agent.js";
export { createForgeAgentTool } from "./tools/forge-agent.js";
export { createForgeChannelTool } from "./tools/forge-channel.js";
export { createForgeEngineTool } from "./tools/forge-engine.js";
export { createForgeMiddlewareTool } from "./tools/forge-middleware.js";
export { createForgeProviderTool } from "./tools/forge-provider.js";
export { createForgeResolverTool } from "./tools/forge-resolver.js";
export { createForgeSkillTool } from "./tools/forge-skill.js";
export { createForgeToolTool } from "./tools/forge-tool.js";
export { createPromoteForgeTool } from "./tools/promote-forge.js";
export { createSearchForgeTool } from "./tools/search-forge.js";
export type { ForgeDeps, ForgeToolConfig } from "./tools/shared.js";
// runtime values — primordial tools
export { createForgeTool } from "./tools/shared.js";
// types — forge-specific (remain in L2)
export type {
  CompositionBrickInfo,
  CompositionMetadata,
  ForgeAgentInput,
  ForgeAgentInputWithBricks,
  ForgeAgentInputWithManifest,
  ForgeChannelInput,
  ForgeCompositeInput,
  ForgeContext,
  ForgeEngineInput,
  ForgeInput,
  ForgeMiddlewareInput,
  ForgeProviderInput,
  ForgeResolverInput,
  ForgeResult,
  ForgeResultMetadata,
  ForgeSkillInput,
  ForgeToolInput,
  ForgeVerifier,
  ManifestParseResult,
  ManifestParser,
  PromoteChange,
  PromoteResult,
  SandboxError,
  SandboxErrorCode,
  SandboxExecutor,
  SandboxResult,
  StageReport,
  TieredSandboxExecutor,
  TierResolution,
  TrustStageReport,
  VerificationReport,
  VerificationStage,
  VerifierResult,
} from "./types.js";
// runtime values — usage tracking & auto-promotion
export type { UsagePromotedResult, UsageRecordedResult, UsageResult } from "./usage.js";
export { computeAutoPromotion, recordBrickUsage } from "./usage.js";
// runtime values — verification
export { verify } from "./verify.js";
export { verifySandbox } from "./verify-sandbox.js";
export { verifySelfTest } from "./verify-self-test.js";
export { verifyStatic } from "./verify-static.js";
export { assignTrust } from "./verify-trust.js";
