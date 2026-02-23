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
  TestCase,
  ToolArtifact,
} from "@koi/core";
// runtime values — adversarial verifiers
export {
  createAdversarialVerifiers,
  createExfiltrationVerifier,
  createInjectionVerifier,
  createResourceExhaustionVerifier,
} from "./adversarial-verifiers.js";
export type { ForgeConfig, ScopePromotionConfig, VerificationConfig } from "./config.js";
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
export { createForgeResolver } from "./forge-resolver.js";
export type { GovernanceResult } from "./governance.js";
// runtime values — governance
export { checkGovernance, checkScopePromotion } from "./governance.js";
// runtime values — storage
export { createInMemoryForgeStore } from "./memory-store.js";
export { createComposeForgeTool } from "./tools/compose-forge.js";
export { createForgeAgentTool } from "./tools/forge-agent.js";
export { createForgeSkillTool } from "./tools/forge-skill.js";
export { createForgeToolTool } from "./tools/forge-tool.js";
export { createPromoteForgeTool } from "./tools/promote-forge.js";
export { createSearchForgeTool } from "./tools/search-forge.js";
export type { ForgeDeps, ForgeToolConfig } from "./tools/shared.js";
// runtime values — primordial tools
export { createForgeTool } from "./tools/shared.js";
// types — forge-specific (remain in L2)
export type {
  ForgeAgentInput,
  ForgeCompositeInput,
  ForgeContext,
  ForgeInput,
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
// runtime values — verification
export { verify } from "./verify.js";
export { verifySandbox } from "./verify-sandbox.js";
export { verifySelfTest } from "./verify-self-test.js";
export { verifyStatic } from "./verify-static.js";
export { assignTrust } from "./verify-trust.js";
