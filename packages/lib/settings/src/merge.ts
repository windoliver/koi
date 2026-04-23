import type { KoiSettings } from "./types.js";

/**
 * Merge an ordered list of settings layers (lowest → highest priority) with
 * an optional policy layer applied as a final enforcement pass.
 *
 * Merge rules:
 *   - Scalars: last layer wins
 *   - Arrays (allow/ask/deny/disabledMcpServers/additionalDirectories): concat + dedup
 *   - Objects (env, hooks): deep-merge by key; last layer's value for a key wins
 *
 * Policy pass: policy.deny removes matching patterns from merged allow/ask,
 * then prepends them to deny. Policy scalars/objects override unconditionally.
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
    env: mergeObjects(base.env, override.env),
    hooks: mergeHooks(base.hooks, override.hooks),
    apiBaseUrl: override.apiBaseUrl ?? base.apiBaseUrl,
    theme: override.theme ?? base.theme,
    enableAllProjectMcpServers:
      override.enableAllProjectMcpServers ?? base.enableAllProjectMcpServers,
    disabledMcpServers: mergeArrays(base.disabledMcpServers, override.disabledMcpServers),
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
    additionalDirectories: mergeArrays(
      base?.additionalDirectories,
      override?.additionalDirectories,
    ),
  };
}

function mergeObjects(
  base: Readonly<Record<string, string>> | undefined,
  override: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (base == null && override == null) return undefined;
  return { ...base, ...override };
}

const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "SessionStart", "SessionEnd", "Stop"] as const;

function mergeHooks(
  base: KoiSettings["hooks"],
  override: KoiSettings["hooks"],
): KoiSettings["hooks"] {
  if (base == null && override == null) return undefined;
  const result: Record<string, unknown> = {};
  for (const ev of HOOK_EVENTS) {
    const merged = mergeArrays(base?.[ev], override?.[ev]);
    if (merged !== undefined) result[ev] = merged;
  }
  return Object.keys(result).length > 0 ? (result as KoiSettings["hooks"]) : undefined;
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
 * Policy scalars/objects override unconditionally.
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
        additionalDirectories: mergeArrays(
          merged.permissions?.additionalDirectories,
          policy.permissions?.additionalDirectories,
        ),
      }
    : undefined;

  return {
    $schema: merged.$schema,
    permissions,
    env: mergeObjects(merged.env, policy.env),
    hooks: mergeHooks(merged.hooks, policy.hooks),
    apiBaseUrl: policy.apiBaseUrl ?? merged.apiBaseUrl,
    theme: policy.theme ?? merged.theme,
    enableAllProjectMcpServers:
      policy.enableAllProjectMcpServers ?? merged.enableAllProjectMcpServers,
    disabledMcpServers: mergeArrays(merged.disabledMcpServers, policy.disabledMcpServers),
  };
}
