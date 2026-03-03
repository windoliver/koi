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
 *   125  koi:capability-request (pull-model delegation requests)
 *   150  koi:governance-backend
 *   200  koi:pay
 *   300  koi:audit
 *   340  koi:pii
 *   350  koi:sanitize
 *   375  koi:guardrails
 */

import type { KoiMiddleware } from "@koi/core/middleware";
import {
  createCapabilityRequestBridge,
  createDelegationMiddleware,
  createDelegationProvider,
} from "@koi/delegation";
import { createExecApprovalsMiddleware } from "@koi/exec-approvals";
import { createAuditMiddleware } from "@koi/middleware-audit";
import { createGovernanceBackendMiddleware } from "@koi/middleware-governance-backend";
import { createGuardrailsMiddleware } from "@koi/middleware-guardrails";
import { createPayMiddleware } from "@koi/middleware-pay";
import { createPermissionsMiddleware } from "@koi/middleware-permissions";
import { createPIIMiddleware } from "@koi/middleware-pii";
import { createSanitizeMiddleware } from "@koi/middleware-sanitize";

import { resolveGovernanceConfig } from "./config-resolution.js";
import { wireGovernanceScope } from "./scope-wiring.js";
import type { GovernanceBundle, GovernanceStackConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Assemble a governance compliance middleware stack.
 *
 * Returns a `GovernanceBundle` with `middlewares`, `providers`, and `config` metadata.
 * Pass `middlewares` and `providers` directly to createKoi():
 *
 * ```typescript
 * const { middlewares, providers } = createGovernanceStack({ preset: "standard" });
 * const runtime = await createKoi({ ..., middleware: middlewares, providers });
 * ```
 *
 * Config resolution: defaults -> preset -> user overrides.
 * Middleware are ordered by priority. Priority overrides are applied for
 * exec-approvals (110) and delegation (120) so they slot correctly between
 * permissions (100) and governance-backend (150).
 */
export function createGovernanceStack(config: GovernanceStackConfig): GovernanceBundle {
  const resolved = resolveGovernanceConfig(config);

  // Validate: capabilityRequest requires delegationBridge
  if (config.capabilityRequest !== undefined && config.delegationBridge === undefined) {
    throw new Error(
      "GovernanceStack: capabilityRequest requires delegationBridge to also be configured",
    );
  }

  // Create capability request bridge when both delegationBridge and capabilityRequest are configured
  const capabilityRequestBridge =
    config.delegationBridge !== undefined && config.capabilityRequest !== undefined
      ? createCapabilityRequestBridge({
          manager: config.delegationBridge.manager,
          approvalTimeoutMs: config.capabilityRequest.approvalTimeoutMs,
          maxForwardDepth: config.capabilityRequest.maxForwardDepth,
        })
      : undefined;

  const candidates: ReadonlyArray<KoiMiddleware | undefined> = [
    resolved.permissions !== undefined
      ? createPermissionsMiddleware(resolved.permissions) // 100
      : undefined,
    resolved.execApprovals !== undefined
      ? { ...createExecApprovalsMiddleware(resolved.execApprovals), priority: 110 } // override
      : undefined,
    resolved.delegation !== undefined
      ? { ...createDelegationMiddleware(resolved.delegation), priority: 120 } // override
      : undefined,
    capabilityRequestBridge?.middleware, // 125
    resolved.governanceBackend !== undefined
      ? createGovernanceBackendMiddleware(resolved.governanceBackend) // 150
      : undefined,
    resolved.pay !== undefined
      ? createPayMiddleware(resolved.pay) // 200
      : undefined,
    resolved.audit !== undefined
      ? createAuditMiddleware(resolved.audit) // 300
      : undefined,
    resolved.pii !== undefined
      ? createPIIMiddleware(resolved.pii) // 340
      : undefined,
    resolved.sanitize !== undefined
      ? createSanitizeMiddleware(resolved.sanitize) // 350
      : undefined,
    resolved.guardrails !== undefined
      ? createGuardrailsMiddleware(resolved.guardrails) // 375
      : undefined,
  ];

  const middlewares = candidates.filter((mw): mw is KoiMiddleware => mw !== undefined);

  // Wire scope providers when scope + backends are present
  const scopeProviders =
    resolved.scope !== undefined && resolved.backends !== undefined
      ? wireGovernanceScope(resolved.scope, resolved.backends, resolved.enforcer)
      : [];

  // Wire delegation provider when delegationBridge is configured
  const delegationProviders =
    config.delegationBridge !== undefined
      ? [createDelegationProvider({ manager: config.delegationBridge.manager, enabled: true })]
      : [];

  const capabilityRequestProviders =
    capabilityRequestBridge !== undefined ? [capabilityRequestBridge.provider] : [];

  const providers = [...scopeProviders, ...delegationProviders, ...capabilityRequestProviders];

  const preset = resolved.preset ?? "open";

  return {
    middlewares,
    providers,
    config: {
      preset,
      middlewareCount: middlewares.length,
      providerCount: providers.length,
      payDeprecated: resolved.pay !== undefined,
      scopeEnabled: resolved.scope !== undefined,
    },
  };
}
