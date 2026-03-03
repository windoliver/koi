/**
 * Runtime enforcement of BrickRequires — checks bins, env vars, tool availability,
 * package resolvability, and network policy.
 */

import type { BrickRequires } from "@koi/core";

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/** Simplified network policy for requires-check: does the environment allow network? */
export interface NetworkPolicy {
  readonly allowed: boolean;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

type ViolationKind = "bin" | "env" | "tool" | "agent" | "package" | "network";

export interface RequiresCheckResult {
  readonly satisfied: boolean;
  readonly violation?: { readonly kind: ViolationKind; readonly name: string };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Try to resolve an npm package from cwd. Returns true when resolvable. */
function isPackageResolvable(pkgName: string): boolean {
  try {
    Bun.resolveSync(pkgName, process.cwd());
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates that all runtime requirements declared by a brick are satisfied.
 * Returns the first violation found (fail-fast). No requires -> always satisfied.
 *
 * Check order: bins -> env -> tools -> agents -> packages -> network.
 */
export function checkBrickRequires(
  requires: BrickRequires | undefined,
  availableToolNames: ReadonlySet<string>,
  networkPolicy?: NetworkPolicy,
  availableAgentNames?: ReadonlySet<string>,
): RequiresCheckResult {
  if (requires === undefined) {
    return { satisfied: true };
  }

  // 1. Binary availability (PATH lookup)
  if (requires.bins !== undefined) {
    for (const bin of requires.bins) {
      if (Bun.which(bin) === null) {
        return { satisfied: false, violation: { kind: "bin", name: bin } };
      }
    }
  }

  // 2. Environment variables
  if (requires.env !== undefined) {
    for (const varName of requires.env) {
      if (process.env[varName] === undefined) {
        return { satisfied: false, violation: { kind: "env", name: varName } };
      }
    }
  }

  // 3. Tool brick names
  if (requires.tools !== undefined) {
    for (const toolName of requires.tools) {
      if (!availableToolNames.has(toolName)) {
        return { satisfied: false, violation: { kind: "tool", name: toolName } };
      }
    }
  }

  // 4. Agent brick names
  if (requires.agents !== undefined) {
    const agentSet = availableAgentNames ?? new Set<string>();
    for (const agentName of requires.agents) {
      if (!agentSet.has(agentName)) {
        return { satisfied: false, violation: { kind: "agent", name: agentName } };
      }
    }
  }

  // 5. npm package resolvability
  if (requires.packages !== undefined) {
    for (const pkgName of Object.keys(requires.packages)) {
      if (!isPackageResolvable(pkgName)) {
        return { satisfied: false, violation: { kind: "package", name: pkgName } };
      }
    }
  }

  // 6. Network access: brick declares network: true but policy disallows it
  if (requires.network === true && networkPolicy !== undefined && !networkPolicy.allowed) {
    return { satisfied: false, violation: { kind: "network", name: "network" } };
  }

  return { satisfied: true };
}
