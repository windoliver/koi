/**
 * In-memory ExecRulesStore implementation.
 *
 * Starts empty. "Always" decisions accumulate in memory only.
 * Useful for testing and development.
 */

import type { ExecRulesStore, PersistedRules } from "./types.js";

export function createInMemoryRulesStore(): ExecRulesStore {
  // let is justified: the store must track mutable accumulated state across saves
  let current: PersistedRules = { allow: [], deny: [] };

  return {
    load: async (): Promise<PersistedRules> => {
      // Return new arrays to prevent callers from mutating internal state
      return { allow: [...current.allow], deny: [...current.deny] };
    },
    save: async (rules: PersistedRules): Promise<void> => {
      current = { allow: [...rules.allow], deny: [...rules.deny] };
    },
  };
}
