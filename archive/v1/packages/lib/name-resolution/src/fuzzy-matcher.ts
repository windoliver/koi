/**
 * Fuzzy name matching for ANS "did you mean?" suggestions.
 *
 * Uses Levenshtein distance from @koi/validation to find near-miss names.
 */

import type { AnsConfig, ForgeScope, NameRecord, NameSuggestion } from "@koi/core";
import { levenshteinDistance } from "@koi/validation";

/**
 * Compute fuzzy suggestions for a name that didn't resolve.
 *
 * Collects all canonical names + aliases from records, computes Levenshtein
 * distance, filters by maxSuggestionDistance, sorts ascending, and returns
 * top maxSuggestions.
 *
 * @param name - The unresolved name to find suggestions for.
 * @param scope - Optional scope to restrict suggestions to.
 * @param records - All current name records.
 * @param config - ANS configuration (distance threshold + max suggestions).
 */
export function computeSuggestions(
  name: string,
  scope: ForgeScope | undefined,
  records: ReadonlyMap<string, NameRecord>,
  config: Pick<AnsConfig, "maxSuggestionDistance" | "maxSuggestions">,
): readonly NameSuggestion[] {
  const candidates: NameSuggestion[] = [];

  for (const record of records.values()) {
    // Skip if scope filter active and record doesn't match
    if (scope !== undefined && record.scope !== scope) {
      continue;
    }

    // Skip expired records
    if (record.expiresAt > 0 && Date.now() > record.expiresAt) {
      continue;
    }

    // Check canonical name
    const canonicalDistance = levenshteinDistance(name, record.name, config.maxSuggestionDistance);
    if (canonicalDistance <= config.maxSuggestionDistance) {
      candidates.push({
        name: record.name,
        distance: canonicalDistance,
        scope: record.scope,
        binding: record.binding,
      });
    }

    // Check aliases
    for (const alias of record.aliases) {
      const aliasDistance = levenshteinDistance(name, alias, config.maxSuggestionDistance);
      if (aliasDistance <= config.maxSuggestionDistance) {
        candidates.push({
          name: alias,
          distance: aliasDistance,
          scope: record.scope,
          binding: record.binding,
        });
      }
    }
  }

  // Sort by distance (ascending), then by name for stability
  candidates.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));

  return Object.freeze(candidates.slice(0, config.maxSuggestions));
}
