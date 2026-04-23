import type { KoiSettings } from "./types.js";

/**
 * Merge an ordered list of settings layers (lowest → highest priority) with
 * an optional policy layer applied as a final enforcement pass.
 *
 * Merge rules:
 *   - Scalars (defaultMode): last layer wins
 *   - Arrays (allow/ask/deny): concat + dedup
 *
 * Policy pass: policy.deny removes matching patterns from merged allow/ask,
 * then prepends them to deny. Policy scalars override unconditionally.
 */
export function mergeSettings(
  layers: readonly (KoiSettings | null | undefined)[],
  policy?: KoiSettings | null | undefined,
): KoiSettings {
  let merged: KoiSettings = {};

  for (const layer of layers) {
    if (layer == null) continue;
    merged = mergePair(merged, layer);
  }

  if (policy != null) {
    merged = applyPolicy(merged, policy);
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function mergePair(base: KoiSettings, override: KoiSettings): KoiSettings {
  return {
    $schema: override.$schema ?? base.$schema,
    permissions: mergePermissions(base.permissions, override.permissions),
  };
}

function mergePermissions(
  base: KoiSettings["permissions"],
  override: KoiSettings["permissions"],
): KoiSettings["permissions"] {
  if (base == null && override == null) return undefined;
  return {
    defaultMode: override?.defaultMode ?? base?.defaultMode,
    allow: mergeArrays(base?.allow, override?.allow),
    ask: mergeArrays(base?.ask, override?.ask),
    deny: mergeArrays(base?.deny, override?.deny),
  };
}

function mergeArrays<T>(
  base: readonly T[] | undefined,
  override: readonly T[] | undefined,
): readonly T[] | undefined {
  if (base == null && override == null) return undefined;
  const combined = [...(base ?? []), ...(override ?? [])];
  return [...new Set(combined)];
}

function parsePermEntry(s: string): { readonly tool: string; readonly arg: string | null } {
  const parenIdx = s.indexOf("(");
  if (parenIdx === -1) return { tool: s, arg: null };
  const tool = s.slice(0, parenIdx);
  const arg = s.slice(parenIdx + 1, s.endsWith(")") ? s.length - 1 : s.length);
  return { tool, arg };
}

/**
 * Returns true when a tool-pattern string `candidate` is subsumed by `denyPattern`.
 *
 * Semantic rules:
 *   `*`            subsumes everything
 *   `Tool`         subsumes `Tool`, `Tool(argGlob)` — bare deny covers all invocations
 *   `Tool(*)`      subsumes `Tool`, `Tool(argGlob)` — wildcard arg covers all invocations
 *   `Tool(argGlob)` subsumes `Tool(argGlob2)` when argGlob glob-matches argGlob2
 *   `Tool(argGlob)` does NOT subsume bare `Tool` — command-scoped deny is narrower
 */
function isSubsumedByDenyPattern(candidate: string, denyPattern: string): boolean {
  if (denyPattern === "*") return true;
  const deny = parsePermEntry(denyPattern);
  const cand = parsePermEntry(candidate);
  if (deny.tool !== cand.tool) return false;
  // Bare deny or Tool(*) covers all invocations of that tool
  if (deny.arg === null || deny.arg === "*") return true;
  // Command-scoped deny does not subsume a bare tool entry
  if (cand.arg === null) return false;
  // Both command-scoped: glob-match the arg portions only
  const regexSrc = deny.arg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${regexSrc}$`).test(cand.arg);
}

/** Returns true if any deny pattern subsumes the candidate. */
function isDenied(candidate: string, denyPatterns: readonly string[]): boolean {
  return denyPatterns.some((d) => isSubsumedByDenyPattern(candidate, d));
}

/**
 * Post-merge policy enforcement pass.
 * Policy deny patterns are removed from merged allow/ask and prepended to deny.
 * Policy scalars override unconditionally.
 */
function applyPolicy(merged: KoiSettings, policy: KoiSettings): KoiSettings {
  const policyDeny = policy.permissions?.deny ?? [];

  // Filter arrays using const + filter (returns new arrays, no mutation)
  const mergedAllow = (merged.permissions?.allow ?? []).filter((p) => !isDenied(p, policyDeny));
  const mergedAsk = (merged.permissions?.ask ?? []).filter((p) => !isDenied(p, policyDeny));
  const mergedDeny =
    policyDeny.length > 0
      ? [...new Set([...policyDeny, ...(merged.permissions?.deny ?? [])])]
      : (merged.permissions?.deny ?? []);

  const hasPermissions = merged.permissions != null || policy.permissions != null;
  // Preserve the array field (even empty) when the merged layer had that field,
  // so callers can distinguish "no ask list" from "empty ask list after policy filtering".
  const hadAllow = merged.permissions?.allow != null || policy.permissions?.allow != null;
  const hadAsk = merged.permissions?.ask != null || policy.permissions?.ask != null;
  const hadDeny = merged.permissions?.deny != null || policy.permissions?.deny != null;
  const permissions = hasPermissions
    ? {
        defaultMode: policy.permissions?.defaultMode ?? merged.permissions?.defaultMode,
        allow: hadAllow ? mergedAllow : undefined,
        ask: hadAsk ? mergedAsk : undefined,
        deny: hadDeny ? mergedDeny : undefined,
      }
    : undefined;

  return {
    $schema: merged.$schema,
    permissions,
  };
}
