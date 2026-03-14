/**
 * @koi/forge-tools — Primordial tools, component provider, resolver,
 * and store utilities for the forge subsystem (Layer 2).
 *
 * Depends on @koi/core (L0), @koi/forge-types (L0u), and selected L0u utilities.
 * Cross-L2 calls (verify, governance, attestation) are injected via ForgePipeline.
 */

// manifest assembly
export type { AssembleManifestOptions, AssembleManifestResult } from "./assemble-manifest.js";
export { assembleManifest } from "./assemble-manifest.js";
// brick conversion — artifact → tool mapping
export { brickCapabilityFragment, brickToTool } from "./brick-conversion.js";
// brick resolver — trust + kind-aware component mapping
export type { DeltaInvalidator } from "./brick-resolver.js";
export {
  createDeltaInvalidator,
  mapBrickToComponent,
  meetsKindTrust,
  meetsMinTrust,
} from "./brick-resolver.js";
// companion skill — forge self-improvement guidance for LLMs
export { createForgeCompanionSkillProvider, FORGE_COMPANION_SKILL } from "./companion-skill.js";
// descriptor — tool descriptor constant
export { descriptor } from "./descriptor.js";

// component provider — ECS forge component
export type {
  ForgeComponentProviderConfig,
  ForgeComponentProviderInstance,
} from "./forge-component-provider.js";
export { createForgeComponentProvider } from "./forge-component-provider.js";

// error adapter — ForgeError → KoiError mapping
export { forgeErrorToKoiError } from "./forge-error-adapter.js";

// registry sync — registry ↔ store sync
export type { ForgeRegistrySyncConfig } from "./forge-registry-sync.js";
export { createForgeRegistrySync } from "./forge-registry-sync.js";

// resolver — forge-aware brick resolver
export type { ForgeResolverContext } from "./forge-resolver.js";
export { createForgeResolver } from "./forge-resolver.js";

// SKILL.md generation
export type { SkillMdInput } from "./generate-skill-md.js";
export { generateSkillMd } from "./generate-skill-md.js";

// in-memory store
export { createInMemoryForgeStore } from "./memory-store.js";

// requires-check — brick dependency validation
export type { NetworkPolicy, RequiresCheckResult } from "./requires-check.js";
export { checkBrickRequires } from "./requires-check.js";

// skill reference provider — progressive disclosure (Phase 3B)
export type {
  SkillInstructions,
  SkillMetadata,
  SkillReferenceProvider,
} from "./skill-reference-provider.js";
export { createSkillReferenceProvider } from "./skill-reference-provider.js";

// store change notifier
export { createMemoryStoreChangeNotifier } from "./store-notifier.js";

// --- delegation ---
export { delegateImplementation, generateDelegationPrompt } from "./tools/delegate.js";

// --- primordial tools ---

// compose_forge
export { createComposeForge } from "./tools/compose-forge.js";

// forge_agent
export type { ForgeSpawnData, OnForgeAgentSpawn } from "./tools/forge-agent.js";
export { createForgeAgentTool } from "./tools/forge-agent.js";

// forge_edit
export { createForgeEditTool } from "./tools/forge-edit.js";

// forge_impl (merged middleware + channel)
export { createForgeChannelTool, createForgeMiddlewareTool } from "./tools/forge-impl.js";

// forge_skill
export { createForgeSkillTool } from "./tools/forge-skill.js";

// forge_tool
export { createForgeToolTool } from "./tools/forge-tool.js";

// promote_forge
export { createPromoteForgeTool } from "./tools/promote-forge.js";

// run_skill_script (Phase 3C)
export type { RunSkillScriptDeps, RunSkillScriptResult } from "./tools/run-skill-script.js";
export { createRunSkillScriptTool } from "./tools/run-skill-script.js";

// search_forge
export { createSearchForgeTool } from "./tools/search-forge.js";

// shared — tool utilities, parsers, pipeline runner
export type {
  ArtifactBuilder,
  DelegateOptions,
  ForgeDeps,
  ForgeToolConfig,
} from "./tools/shared.js";
export {
  createForgeTool,
  mapParsedBaseFields,
  mapParsedTestCases,
  runForgePipeline,
} from "./tools/shared.js";
