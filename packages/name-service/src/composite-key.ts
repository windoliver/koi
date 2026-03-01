/**
 * Composite key utilities for ANS records.
 *
 * Keys are `${scope}:${name}` — colons are forbidden in names,
 * so the split is always unambiguous.
 */

import type { ForgeScope } from "@koi/core";

/** Valid ForgeScope values for type-safe parsing. */
const VALID_SCOPES = new Set<string>(["agent", "zone", "global"]);

/** Type guard for ForgeScope. */
function isForgeScope(value: string): value is ForgeScope {
  return VALID_SCOPES.has(value);
}

/** Create a composite key from scope and name. */
export function compositeKey(scope: ForgeScope, name: string): string {
  return `${scope}:${name}`;
}

/** Parse a composite key back into scope and name. Throws on malformed keys. */
export function parseCompositeKey(key: string): {
  readonly scope: ForgeScope;
  readonly name: string;
} {
  const colonIndex = key.indexOf(":");
  const scopeStr = key.slice(0, colonIndex);
  if (!isForgeScope(scopeStr)) {
    throw new Error(
      `Invalid composite key "${key}": scope "${scopeStr}" is not a valid ForgeScope`,
    );
  }
  return { scope: scopeStr, name: key.slice(colonIndex + 1) };
}
