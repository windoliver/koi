/**
 * Pure scope-based resolution logic for ANS.
 *
 * Resolves a name by checking scopes in priority order (agent -> zone -> global),
 * looking up both canonical names and aliases.
 */

import type { ForgeScope, KoiError, NameRecord, NameResolution, Result } from "@koi/core";
import { ANS_SCOPE_PRIORITY, RETRYABLE_DEFAULTS } from "@koi/core";
import { compositeKey } from "./composite-key.js";

/** Ordered list of scopes from highest to lowest priority. */
const SCOPE_ORDER: readonly ForgeScope[] = [
  ...(Object.entries(ANS_SCOPE_PRIORITY) as ReadonlyArray<readonly [ForgeScope, number]>),
]
  .sort(([, a]: readonly [ForgeScope, number], [, b]: readonly [ForgeScope, number]) => a - b)
  .map(([scope]: readonly [ForgeScope, number]) => scope);

/** Check whether a record has expired. */
function isExpired(record: NameRecord): boolean {
  return record.expiresAt > 0 && Date.now() > record.expiresAt;
}

/**
 * Resolve a name to a NameResolution by checking scopes in priority order.
 *
 * Pure function — takes the two lookup maps as arguments.
 *
 * @param name - The name to resolve (canonical or alias).
 * @param scope - Optional scope to restrict resolution to.
 * @param records - Map of composite key -> NameRecord.
 * @param aliases - Map of alias composite key -> canonical composite key.
 */
export function resolveByScope(
  name: string,
  scope: ForgeScope | undefined,
  records: ReadonlyMap<string, NameRecord>,
  aliases: ReadonlyMap<string, string>,
): Result<NameResolution, KoiError> {
  const scopesToCheck: readonly ForgeScope[] = scope !== undefined ? [scope] : SCOPE_ORDER;

  for (const s of scopesToCheck) {
    // Check canonical name first
    const key = compositeKey(s, name);
    const record = records.get(key);
    if (record !== undefined && !isExpired(record)) {
      return {
        ok: true,
        value: { record, matchedAlias: false, matchedName: name },
      };
    }

    // Check if name is an alias
    const canonicalKey = aliases.get(key);
    if (canonicalKey !== undefined) {
      const canonicalRecord = records.get(canonicalKey);
      if (canonicalRecord !== undefined && !isExpired(canonicalRecord)) {
        return {
          ok: true,
          value: { record: canonicalRecord, matchedAlias: true, matchedName: name },
        };
      }
    }
  }

  return {
    ok: false,
    error: {
      code: "NOT_FOUND",
      message: `Name "${name}" not found${scope !== undefined ? ` in scope "${scope}"` : ""}`,
      retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
      context: { name, scope: scope ?? "all" },
    },
  };
}
