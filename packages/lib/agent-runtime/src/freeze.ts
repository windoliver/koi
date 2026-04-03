/**
 * Deep freeze utility for agent definitions.
 *
 * Recursively freezes an object and all nested objects/arrays to prevent
 * runtime mutation of shared definitions (cached built-ins, registry entries).
 */

import type { AgentDefinition } from "@koi/core";

/** Recursively freeze an object and all nested objects/arrays. */
function deepFreeze<T>(obj: T): T {
  if (obj === null || obj === undefined || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}

/** Deep-freeze an AgentDefinition and all its nested objects. */
export function deepFreezeDefinition(def: AgentDefinition): AgentDefinition {
  return deepFreeze({ ...def });
}
