import type { KoiSettings } from "@koi/settings";
import type { RuleEffect, RuleSource, SourcedRule } from "./rule-types.js";

/**
 * Parse a settings permission string into a SourcedRule pattern+action pair.
 *
 * Settings strings use the format "ToolName(commandGlob)" where the command
 * glob refers to the tool's enriched resource key (e.g. "Bash:git push").
 * The permission backend always receives action:"invoke" from the middleware,
 * so command-scoped constraints are encoded in the pattern field.
 *
 *   "Read(*)"         → { pattern: "Read**",        action: "invoke" }
 *   "Bash(git push*)" → { pattern: "Bash:git push*", action: "invoke" }
 *   "Bash(rm -rf*)"   → { pattern: "Bash:rm -rf*",  action: "invoke" }
 *   "WebFetch"        → { pattern: "WebFetch**",     action: "invoke" }
 *   "*"               → { pattern: "**",             action: "invoke" }
 */
function parsePermissionString(s: string): { readonly pattern: string; readonly action: string } {
  if (s === "*") {
    return { pattern: "**", action: "invoke" };
  }
  const parenIdx = s.indexOf("(");
  if (parenIdx === -1) {
    // Bare tool name: match plain resource "ToolName" and enriched "ToolName:anything"
    return { pattern: `${s}**`, action: "invoke" };
  }
  const toolName = s.slice(0, parenIdx);
  const argGlob = s.slice(parenIdx + 1, s.endsWith(")") ? s.length - 1 : s.length);
  if (argGlob === "*") {
    // "ToolName(*)" — any invocation of that tool
    return { pattern: `${toolName}**`, action: "invoke" };
  }
  // "ToolName(commandGlob)" — encode command constraint in the resource pattern.
  // Middleware enriches tool resources as "ToolName:commandPrefix", so the
  // pattern "ToolName:commandGlob" matches those enriched resource keys.
  return { pattern: `${toolName}:${argGlob}`, action: "invoke" };
}

/**
 * Convert `KoiSettings.permissions` string arrays into `SourcedRule[]`
 * for use with `createPermissionBackend`.
 *
 * Rules are emitted in order: deny, ask, allow — most restrictive first.
 * This ensures that within a single settings layer, deny rules shadow
 * broader allows when the evaluator uses first-match-wins semantics.
 *
 * **Command-scoped rules** (e.g. `"Bash(git push*)"`) are encoded as
 * resource patterns (`"Bash:git push*"`) with `action: "invoke"`.  They
 * only take effect when the caller's backend performs dual-key evaluation
 * (i.e. `createPatternPermissionBackend` from `@koi/middleware-permissions`,
 * which is marker-aware).  With the plain `createPermissionBackend` in
 * single-key mode (`allowLegacyBackendBashFallback: true`) these rules are
 * silently treated as if no command constraint was specified.
 */
export function mapSettingsToSourcedRules(
  settings: KoiSettings,
  layer: RuleSource,
): readonly SourcedRule[] {
  const perms = settings.permissions;
  if (perms == null) return [];

  // Deny-first ordering: deny > ask > allow within a layer.
  // Prevents a broad allow from silently shadowing a narrower deny.
  const buckets: ReadonlyArray<{
    readonly strings: readonly string[] | undefined;
    readonly effect: RuleEffect;
  }> = [
    { strings: perms.deny, effect: "deny" },
    { strings: perms.ask, effect: "ask" },
    { strings: perms.allow, effect: "allow" },
  ];

  const rules: SourcedRule[] = [];
  for (const { strings, effect } of buckets) {
    if (strings == null) continue;
    for (const s of strings) {
      const { pattern, action } = parsePermissionString(s);
      rules.push({ pattern, action, effect, source: layer });
    }
  }

  return rules;
}
