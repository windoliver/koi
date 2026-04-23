import type { JsonObject } from "@koi/core";
import type { PolicyRequestKind } from "@koi/core/governance-backend";

/**
 * Compute a stable SHA-256 hex digest for a (kind, payload) pair.
 * Used as the session-scoped grant key so approving one (kind, payload)
 * cannot bleed into a materially different call.
 *
 * Canonicalization rules:
 *   - Object keys are sorted recursively.
 *   - Arrays preserve order (semantically meaningful).
 *   - `undefined` values are dropped (JSON semantics).
 */
export function computeGrantKey(kind: PolicyRequestKind, payload: JsonObject): string {
  const canonical = canonicalJsonStringify({ kind, payload });
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonical);
  return hasher.digest("hex");
}

function canonicalJsonStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      const entries = Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      const sorted: Record<string, unknown> = {};
      for (const [k, v2] of entries) sorted[k] = v2;
      return sorted;
    }
    return val;
  });
}
