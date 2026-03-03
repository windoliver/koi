/**
 * Config resolution: 3-layer merge (defaults -> preset -> user overrides).
 *
 * Validates mutual exclusion constraints and emits deprecation warnings.
 */

import { createPatternPermissionBackend } from "@koi/middleware-permissions";

import { GOVERNANCE_PRESET_SPECS } from "./presets.js";
import type { GovernanceStackConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Deprecation warning emitted when `pay` is provided. */
export const PAY_DEPRECATION_WARNING: string =
  "[@koi/governance] 'pay' is deprecated and will be removed in the next major release. " +
  "Use @koi/middleware-pay directly instead.";

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve governance config by merging preset defaults under user overrides.
 *
 * Validation rules:
 * - `permissions` and `permissionRules` are mutually exclusive (throws)
 * - `execApprovals.onAsk` is optional — auto-wired during agent assembly when parent + mailbox available
 * - `pay` emits a console.warn deprecation notice
 */
export function resolveGovernanceConfig(config: GovernanceStackConfig): GovernanceStackConfig {
  // 1. Determine preset
  const preset = config.preset ?? "open";
  const spec = GOVERNANCE_PRESET_SPECS[preset];

  // 2. Validate mutual exclusion: permissions XOR permissionRules
  if (config.permissions !== undefined && config.permissionRules !== undefined) {
    throw new Error(
      "[@koi/governance] Cannot provide both 'permissions' and 'permissionRules'. " +
        "Use 'permissionRules' for pattern-based rules, or 'permissions' for a custom backend.",
    );
  }

  // 3. Resolve exec-approvals (onAsk is optional — auto-wired during agent assembly if parent + mailbox available)
  const effectiveExecApprovals = config.execApprovals ?? spec.execApprovals;

  // 4. Resolve permissions from rules shorthand or preset
  const effectivePermissionRules = config.permissionRules ?? spec.permissionRules;
  const effectivePermissions =
    config.permissions ??
    (effectivePermissionRules !== undefined
      ? { backend: createPatternPermissionBackend({ rules: effectivePermissionRules }) }
      : spec.permissions);

  // 5. Pay deprecation warning
  if (config.pay !== undefined) {
    console.warn(PAY_DEPRECATION_WARNING);
  }

  // 6. Merge: user override ?? preset ?? undefined
  return {
    ...config,
    permissions: effectivePermissions,
    execApprovals: effectiveExecApprovals,
    delegation: config.delegation ?? spec.delegation,
    governanceBackend: config.governanceBackend ?? spec.governanceBackend,
    audit: config.audit ?? spec.audit,
    pii: config.pii ?? spec.pii,
    sanitize: config.sanitize ?? spec.sanitize,
    guardrails: config.guardrails ?? spec.guardrails,
    scope: config.scope ?? spec.scope,
  };
}
