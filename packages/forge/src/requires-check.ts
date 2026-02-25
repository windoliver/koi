/**
 * Runtime enforcement of BrickRequires — checks bins, env vars, and tool availability.
 */

import type { BrickRequires } from "@koi/core";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface RequiresCheckResult {
  readonly satisfied: boolean;
  readonly violation?: { readonly kind: "bin" | "env" | "tool"; readonly name: string };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates that all runtime requirements declared by a brick are satisfied.
 * Returns the first violation found (fail-fast). No requires → always satisfied.
 */
export function checkBrickRequires(
  requires: BrickRequires | undefined,
  availableToolNames: ReadonlySet<string>,
): RequiresCheckResult {
  if (requires === undefined) {
    return { satisfied: true };
  }

  if (requires.bins !== undefined) {
    for (const bin of requires.bins) {
      if (Bun.which(bin) === null) {
        return { satisfied: false, violation: { kind: "bin", name: bin } };
      }
    }
  }

  if (requires.env !== undefined) {
    for (const varName of requires.env) {
      if (process.env[varName] === undefined) {
        return { satisfied: false, violation: { kind: "env", name: varName } };
      }
    }
  }

  if (requires.tools !== undefined) {
    for (const toolName of requires.tools) {
      if (!availableToolNames.has(toolName)) {
        return { satisfied: false, violation: { kind: "tool", name: toolName } };
      }
    }
  }

  return { satisfied: true };
}
