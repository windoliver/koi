/**
 * @koi/governance — Enterprise compliance meta-package (Layer 3)
 *
 * One-line enterprise compliance for AI agent deployments.
 * Composes up to 12 middleware + scope providers via createGovernanceStack():
 *
 *   permissions → exec-approvals → delegation → capability-request →
 *   delegation-escalation → governance-backend → pay → intent-capsule →
 *   audit → pii → sanitize → agent-monitor → guardrails
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

// ── Types: agent-monitor ──────────────────────────────────────────────
export type { AgentMonitorConfig, AnomalySignal, SessionMetricsSummary } from "@koi/agent-monitor";
// ── Types: audit backends ────────────────────────────────────────────────
export type { NdjsonAuditSinkConfig, SqliteAuditSinkConfig } from "@koi/audit-sink-local";
// ── Factories: audit backends ────────────────────────────────────────────
export { createNdjsonAuditSink, createSqliteAuditSink } from "@koi/audit-sink-local";
export type { NexusAuditSinkConfig } from "@koi/audit-sink-nexus";
export { createNexusAuditSink, validateNexusAuditSinkConfig } from "@koi/audit-sink-nexus";
// ── Types: capability verifier ──────────────────────────────────────────
export type { SessionRevocationStore } from "@koi/capability-verifier";
// ── Types: middleware sub-configs ────────────────────────────────────────
export type { DelegationMiddlewareConfig, DelegationProviderConfig } from "@koi/delegation";
export type { ExecApprovalsConfig } from "@koi/exec-approvals";
export type { AuditMiddlewareConfig } from "@koi/middleware-audit";
export type {
  DelegationEscalationConfig,
  DelegationEscalationHandle,
} from "@koi/middleware-delegation-escalation";
export type { GovernanceBackendMiddlewareConfig } from "@koi/middleware-governance-backend";
export type { GuardrailsConfig } from "@koi/middleware-guardrails";
export type { IntentCapsuleConfig } from "@koi/middleware-intent-capsule";
export type { PayMiddlewareConfig } from "@koi/middleware-pay";
export type {
  PatternBackendConfig,
  PermissionRules,
  PermissionsMiddlewareConfig,
} from "@koi/middleware-permissions";
export type { PIIConfig } from "@koi/middleware-pii";
export type { SanitizeMiddlewareConfig } from "@koi/middleware-sanitize";
export type {
  RedactionConfig,
  RedactObjectResult,
  Redactor,
  RedactStringResult,
} from "@koi/redaction";
// ── Types: security-analyzer ──────────────────────────────────────────
export type { AnomalySignalLike, RulesAnalyzerConfig } from "@koi/security-analyzer";
// ── Functions ───────────────────────────────────────────────────────────
export { resolveGovernanceConfig } from "./config-resolution.js";
export { createGovernanceStack } from "./governance-stack.js";
// ── Constants ───────────────────────────────────────────────────────────
export { GOVERNANCE_PRESET_SPECS } from "./presets.js";
// ── Types: governance bundle ────────────────────────────────────────────
export type {
  AuditBackendConfig,
  GovernanceBundle,
  GovernancePreset,
  GovernancePresetSpec,
  GovernanceScopeBackends,
  GovernanceScopeConfig,
  GovernanceStackConfig,
  NexusDelegationHooks,
  ResolvedGovernanceMeta,
  SecurityAnalyzerGovernanceConfig,
} from "./types.js";
