/**
 * @koi/governance — Enterprise compliance meta-package (Layer 3)
 *
 * One-line enterprise compliance for AI agent deployments.
 * Composes up to 9 middleware + scope providers via createGovernanceStack():
 *
 *   permissions → exec-approvals → delegation → governance-backend →
 *   pay → audit → pii → sanitize → guardrails
 *
 * Supports deployment presets: "open" (default), "standard", "strict".
 *
 * Usage:
 * ```typescript
 * import { createGovernanceStack } from "@koi/governance";
 *
 * const { middlewares, providers, config } = createGovernanceStack({
 *   preset: "standard",
 *   audit: { sink: myAuditSink },
 * });
 * const runtime = await createKoi({ ..., middleware: middlewares, providers });
 * ```
 */

// ── Types: middleware sub-configs ────────────────────────────────────────
export type { DelegationMiddlewareConfig, DelegationProviderConfig } from "@koi/delegation";
export type { ExecApprovalsConfig } from "@koi/exec-approvals";
export type { AuditMiddlewareConfig } from "@koi/middleware-audit";
export type { GovernanceBackendMiddlewareConfig } from "@koi/middleware-governance-backend";
export type { GuardrailsConfig } from "@koi/middleware-guardrails";
/** @deprecated Use @koi/middleware-pay directly. */
export type { PayMiddlewareConfig } from "@koi/middleware-pay";
export type {
  PatternBackendConfig,
  PermissionRules,
  PermissionsMiddlewareConfig,
} from "@koi/middleware-permissions";
export type { PIIConfig } from "@koi/middleware-pii";
export type { SanitizeMiddlewareConfig } from "@koi/middleware-sanitize";
// ── Functions ───────────────────────────────────────────────────────────
export { resolveGovernanceConfig } from "./config-resolution.js";
export { createGovernanceStack } from "./governance-stack.js";
// ── Constants ───────────────────────────────────────────────────────────
export { GOVERNANCE_PRESET_SPECS } from "./presets.js";
// ── Types: governance bundle ────────────────────────────────────────────
export type {
  GovernanceBundle,
  GovernancePreset,
  GovernancePresetSpec,
  GovernanceScopeBackends,
  GovernanceScopeConfig,
  GovernanceStackConfig,
  NexusDelegationHooks,
  ResolvedGovernanceMeta,
} from "./types.js";
