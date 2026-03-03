/**
 * @koi/forge-verifier — Verification pipeline, adversarial probes,
 * workspace management, and dependency auditing for the forge subsystem.
 *
 * L2 package: depends on @koi/core (L0), @koi/forge-types (L0u), @koi/hash (L0u).
 */

// adversarial-verifiers.ts — built-in adversarial probes
export {
  createAdversarialVerifiers,
  createContentScanningVerifier,
  createExfiltrationVerifier,
  createInjectionVerifier,
  createResourceExhaustionVerifier,
  createStructuralHidingVerifier,
} from "./adversarial-verifiers.js";
export type { BrickModulePath } from "./brick-module-compiler.js";
// brick-module-compiler.ts — content-addressed module writer
export { cleanupOrphanedModules, compileBrickModule } from "./brick-module-compiler.js";
// dependency-audit.ts — dependency audit gate
export { auditDependencies, auditTransitiveDependencies } from "./dependency-audit.js";
export type { DiagnosticVerifierConfig } from "./forge-diagnostic-verifier.js";
// forge-diagnostic-verifier.ts — diagnostic provider verifier
export { createDiagnosticVerifier } from "./forge-diagnostic-verifier.js";
export type { GenerateTestCasesConfig } from "./generate-test-cases.js";
// generate-test-cases.ts — CDGP test case auto-generation
export { generateTestCases } from "./generate-test-cases.js";
export type { CodeSnippet, EnrichedSandboxError } from "./sandbox-error-enrichment.js";
// sandbox-error-enrichment.ts — sandbox error enrichment
export {
  computeRemediation,
  enrichSandboxError,
  extractSnippet,
  sanitizeInput,
} from "./sandbox-error-enrichment.js";
// verify.ts — pipeline orchestrator
export { verify } from "./verify.js";
export type { FormatStageReport } from "./verify-format.js";
// verify-format.ts — Stage 1.25: auto-format
export { verifyFormat } from "./verify-format.js";
// verify-install-integrity.ts — post-install integrity verification
export { verifyInstallIntegrity } from "./verify-install-integrity.js";
// verify-resolve.ts — Stage 1.5: dependency resolution
export { verifyResolve } from "./verify-resolve.js";
// verify-sandbox.ts — Stage 2: sandbox execution
export { verifySandbox } from "./verify-sandbox.js";
// verify-self-test.ts — Stage 3: self-test + pluggable verifiers
export { verifySelfTest } from "./verify-self-test.js";
// verify-static.ts — Stage 1: static validation
export { verifyStatic } from "./verify-static.js";
// verify-trust.ts — Stage 4: trust tier assignment
export { assignTrust } from "./verify-trust.js";
export type { WorkspaceResult } from "./workspace-manager.js";
// workspace-manager.ts — brick workspace creation and caching
export {
  cleanupStaleWorkspaces,
  computeDependencyHash,
  createBrickWorkspace,
  resolveWorkspacePath,
  writeBrickEntry,
} from "./workspace-manager.js";
export type { ScanFinding, ScanResult } from "./workspace-scan.js";
// workspace-scan.ts — node_modules code scanner
export { scanWorkspaceCode } from "./workspace-scan.js";
