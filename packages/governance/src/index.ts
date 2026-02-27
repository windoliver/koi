/**
 * @koi/governance — Enterprise compliance meta-package (Layer 3)
 *
 * One-line enterprise compliance for AI agent deployments.
 * Composes 9 middleware into a single createGovernanceStack() factory:
 *
 *   permissions → exec-approvals → delegation → governance-backend →
 *   pay → audit → pii → sanitize → guardrails
 *
 * Usage:
 * ```typescript
 * import { createGovernanceStack } from "@koi/governance";
 * import { createInMemoryAuditSink } from "@koi/middleware-audit";
 *
 * const { middlewares } = createGovernanceStack({
 *   audit: { sink: createInMemoryAuditSink() },
 *   // add more as needed
 * });
 * const runtime = await createKoi({ ..., middleware: middlewares });
 * ```
 */

export type { DelegationMiddlewareConfig } from "@koi/delegation";
export type { ExecApprovalsConfig } from "@koi/exec-approvals";

// Sub-config types for callers building the config
export type { AuditMiddlewareConfig } from "@koi/middleware-audit";
export type { GovernanceBackendMiddlewareConfig } from "@koi/middleware-governance-backend";
export type { GuardrailsConfig } from "@koi/middleware-guardrails";
export type { PayMiddlewareConfig } from "@koi/middleware-pay";
export type { PermissionsMiddlewareConfig } from "@koi/middleware-permissions";
export type { PIIConfig } from "@koi/middleware-pii";
export type { SanitizeMiddlewareConfig } from "@koi/middleware-sanitize";
export type { GovernanceStackConfig } from "./governance-stack.js";
// Factory + config
export { createGovernanceStack } from "./governance-stack.js";
