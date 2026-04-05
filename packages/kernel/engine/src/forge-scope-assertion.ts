/**
 * Forge scope consistency assertion — dev-time guard for ComponentProvider authors.
 *
 * Enforces that a provider's COMPONENT_PRIORITY is consistent with the ForgeScope
 * it claims for the tools it registers. A GLOBAL_FORGED provider (priority 50) that
 * registers tools with "agent" scope is misleading: the tool would be invisible to
 * children (scope filter excludes it) but registered at global priority, creating
 * confusion during scope filtering failures.
 *
 * Priority → expected scope ceiling:
 *   AGENT_FORGED  (0)   → "agent"  (local-only; cannot be zone or global)
 *   ZONE_FORGED   (10)  → "zone"   (zone-wide; cannot be global)
 *   GLOBAL_FORGED (50)  → "global" (tree-wide; any scope valid)
 *   BUNDLED       (100) → any      (primordial; no scope restriction)
 *
 * Call this at provider registration time in development builds. It is a no-op
 * in production (safe to leave in — the check is O(1) per provider).
 *
 * Layer: L1 — imports only L0 types.
 */

import type { ForgeScope } from "@koi/core";
import { COMPONENT_PRIORITY } from "@koi/core";

/** Allowed ForgeScope values per COMPONENT_PRIORITY level. */
const ALLOWED_SCOPES: ReadonlyMap<number, ReadonlySet<ForgeScope>> = new Map([
  [COMPONENT_PRIORITY.AGENT_FORGED, new Set<ForgeScope>(["agent"])],
  [COMPONENT_PRIORITY.ZONE_FORGED, new Set<ForgeScope>(["agent", "zone"])],
  [COMPONENT_PRIORITY.GLOBAL_FORGED, new Set<ForgeScope>(["agent", "zone", "global"])],
  // BUNDLED (100) — primordial/manifest-defined; no scope restriction applied
]);

/**
 * Asserts that a provider's declared priority is consistent with the ForgeScope
 * it assigns to its tools.
 *
 * @param providerName - Name of the ComponentProvider (for error messages)
 * @param priority - The provider's COMPONENT_PRIORITY value
 * @param toolScopes - Map of tool name → ForgeScope for each tool the provider registers
 * @throws Error if any tool's scope is inconsistent with the provider's priority
 *
 * @example
 * assertProviderScopeConsistency("my-tool-provider", COMPONENT_PRIORITY.ZONE_FORGED, {
 *   "my-tool": "zone",    // OK: zone ⊆ allowed at ZONE_FORGED
 *   "other-tool": "global", // ERROR: global is not allowed at ZONE_FORGED priority
 * });
 */
export function assertProviderScopeConsistency(
  providerName: string,
  priority: number,
  toolScopes: Readonly<Record<string, ForgeScope>>,
): void {
  const allowed = ALLOWED_SCOPES.get(priority);
  if (allowed === undefined) {
    // BUNDLED or unknown priority — no restriction
    return;
  }

  const violations: string[] = [];
  for (const [toolName, scope] of Object.entries(toolScopes)) {
    if (!allowed.has(scope)) {
      violations.push(`"${toolName}" has scope "${scope}" (not allowed at this priority)`);
    }
  }

  if (violations.length > 0) {
    const priorityName = priorityLabel(priority);
    throw new Error(
      `[assertProviderScopeConsistency] Provider "${providerName}" (priority=${priorityName}) ` +
        `registered tools with scopes inconsistent with its priority level. ` +
        `Allowed scopes: ${[...allowed].join(", ")}. ` +
        `Violations: ${violations.join("; ")}. ` +
        `Fix: either lower the provider priority or change the tool's ForgeScope.`,
    );
  }
}

function priorityLabel(priority: number): string {
  if (priority === COMPONENT_PRIORITY.AGENT_FORGED) return `AGENT_FORGED(${priority})`;
  if (priority === COMPONENT_PRIORITY.ZONE_FORGED) return `ZONE_FORGED(${priority})`;
  if (priority === COMPONENT_PRIORITY.GLOBAL_FORGED) return `GLOBAL_FORGED(${priority})`;
  if (priority === COMPONENT_PRIORITY.BUNDLED) return `BUNDLED(${priority})`;
  return String(priority);
}
