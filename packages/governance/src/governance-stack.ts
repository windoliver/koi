/**
 * createGovernanceStack — enterprise compliance middleware assembly.
 *
 * Composes up to 9 middleware into a single stack with a fixed priority order.
 * All fields are optional — include only what your deployment needs.
 *
 * Priority order (lower = outer layer, runs first on request):
 *   100  koi:permissions
 *   110  koi:exec-approvals  (overridden from default 100)
 *   120  koi:delegation      (overridden from default undefined/500)
 *   150  koi:governance-backend
 *   200  koi:pay
 *   300  koi:audit
 *   340  koi:pii
 *   350  koi:sanitize
 *   375  koi:guardrails
 */

import type { KoiMiddleware } from "@koi/core/middleware";
import type { DelegationMiddlewareConfig } from "@koi/delegation";
import { createDelegationMiddleware } from "@koi/delegation";
import type { ExecApprovalsConfig } from "@koi/exec-approvals";
import { createExecApprovalsMiddleware } from "@koi/exec-approvals";
import type { AuditMiddlewareConfig } from "@koi/middleware-audit";
import { createAuditMiddleware } from "@koi/middleware-audit";
import type { GovernanceBackendMiddlewareConfig } from "@koi/middleware-governance-backend";
import { createGovernanceBackendMiddleware } from "@koi/middleware-governance-backend";
import type { GuardrailsConfig } from "@koi/middleware-guardrails";
import { createGuardrailsMiddleware } from "@koi/middleware-guardrails";
import type { PayMiddlewareConfig } from "@koi/middleware-pay";
import { createPayMiddleware } from "@koi/middleware-pay";
import type { PermissionsMiddlewareConfig } from "@koi/middleware-permissions";
import { createPermissionsMiddleware } from "@koi/middleware-permissions";
import type { PIIConfig } from "@koi/middleware-pii";
import { createPIIMiddleware } from "@koi/middleware-pii";
import type { SanitizeMiddlewareConfig } from "@koi/middleware-sanitize";
import { createSanitizeMiddleware } from "@koi/middleware-sanitize";

/**
 * Configuration for the governance compliance stack.
 * All fields are optional — include only the middleware you need.
 */
export interface GovernanceStackConfig {
  /** Coarse-grained tool allow/deny/ask rules. Priority 100. */
  readonly permissions?: PermissionsMiddlewareConfig;
  /** Progressive command allowlisting. Priority 110 (overridden from default). */
  readonly execApprovals?: ExecApprovalsConfig;
  /** Delegation grant verification. Priority 120 (overridden from default). */
  readonly delegation?: DelegationMiddlewareConfig;
  /** Pluggable policy evaluation gate. Priority 150. */
  readonly governanceBackend?: GovernanceBackendMiddlewareConfig;
  /** Token budget enforcement. Priority 200. */
  readonly pay?: PayMiddlewareConfig;
  /** Compliance audit logging. Priority 300. */
  readonly audit?: AuditMiddlewareConfig;
  /** PII detection and redaction. Priority 340. */
  readonly pii?: PIIConfig;
  /** Content sanitization. Priority 350. */
  readonly sanitize?: SanitizeMiddlewareConfig;
  /** Output schema validation. Priority 375. */
  readonly guardrails?: GuardrailsConfig;
}

/**
 * Assemble a governance compliance middleware stack.
 *
 * Returns an object with `middlewares` — pass it directly to createKoi():
 *
 * ```typescript
 * const { middlewares } = createGovernanceStack({ audit: { sink: myAuditSink } });
 * const runtime = await createKoi({ ..., middleware: middlewares });
 * ```
 *
 * Middleware are ordered by priority. Priority overrides are applied for
 * exec-approvals (110) and delegation (120) so they slot correctly between
 * permissions (100) and governance-backend (150).
 */
export function createGovernanceStack(config: GovernanceStackConfig): {
  readonly middlewares: readonly KoiMiddleware[];
} {
  const candidates: ReadonlyArray<KoiMiddleware | undefined> = [
    config.permissions !== undefined
      ? createPermissionsMiddleware(config.permissions) // 100
      : undefined,
    config.execApprovals !== undefined
      ? { ...createExecApprovalsMiddleware(config.execApprovals), priority: 110 } // override from 100
      : undefined,
    config.delegation !== undefined
      ? { ...createDelegationMiddleware(config.delegation), priority: 120 } // override from default
      : undefined,
    config.governanceBackend !== undefined
      ? createGovernanceBackendMiddleware(config.governanceBackend) // 150
      : undefined,
    config.pay !== undefined
      ? createPayMiddleware(config.pay) // 200
      : undefined,
    config.audit !== undefined
      ? createAuditMiddleware(config.audit) // 300
      : undefined,
    config.pii !== undefined
      ? createPIIMiddleware(config.pii) // 340
      : undefined,
    config.sanitize !== undefined
      ? createSanitizeMiddleware(config.sanitize) // 350
      : undefined,
    config.guardrails !== undefined
      ? createGuardrailsMiddleware(config.guardrails) // 375
      : undefined,
  ];

  return {
    middlewares: candidates.filter((mw): mw is KoiMiddleware => mw !== undefined),
  };
}
