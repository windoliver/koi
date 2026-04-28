import type { JsonObject } from "@koi/core";
import type { PolicyRequestKind } from "@koi/core/governance-backend";
import type { AliasSpec } from "./types.js";

/**
 * Rewrite payload fields according to the alias specs. Fresh object
 * on rewrite; input reference on no-op. First matching spec wins per
 * field. Non-string field values are left untouched.
 */
export function applyAliases(
  kind: PolicyRequestKind,
  payload: JsonObject,
  aliases: readonly AliasSpec[],
): JsonObject {
  if (aliases.length === 0) return payload;
  let next: Record<string, unknown> | undefined;
  for (const alias of aliases) {
    if (alias.kind !== kind) continue;
    const current = (next ?? payload)[alias.field];
    if (current !== alias.from) continue;
    if (next === undefined) next = { ...payload };
    next[alias.field] = alias.to;
  }
  return next ?? payload;
}
