import type { KoiSettings } from "@koi/settings";
import type { RuleEffect, RuleSource, SourcedRule } from "./rule-types.js";

/**
 * Parse a settings permission string into one or two pattern+action pairs.
 *
 * Settings strings use the format "ToolName(commandGlob)" where the command
 * glob refers to the tool's enriched resource key (e.g. "Bash:git push").
 * The permission backend always receives action:"invoke" from the middleware,
 * so command-scoped constraints are encoded in the pattern field.
 *
 * Bare tool names and `ToolName(*)` emit TWO patterns to avoid matching
 * unrelated tool IDs that share the same prefix (e.g. "Read" must not
 * match "ReadSecret"):
 *   "Read(*)"  → [{ pattern: "Read" }, { pattern: "Read:**" }]
 *   "Read"     → [{ pattern: "Read" }, { pattern: "Read:**" }]
 *
 * The first pattern matches the exact plain tool id; the second matches
 * any enriched resource for that tool (e.g. "Read:/path/to/file").
 * Using `:**` (double-star after the colon) captures paths with slashes.
 *
 * Command-scoped strings use a single rule:
 *   "Bash(git push*)" → [{ pattern: "Bash:git push*" }]
 *   "Bash(rm -rf*)"   → [{ pattern: "Bash:rm -rf*" }]
 *
 * Wildcard-only string:
 *   "*"               → [{ pattern: "**" }]
 */
function parsePermissionString(
  s: string,
): ReadonlyArray<{ readonly pattern: string; readonly action: string }> {
  if (s === "*") {
    return [{ pattern: "**", action: "invoke" }];
  }
  const parenIdx = s.indexOf("(");
  if (parenIdx === -1) {
    // Bare tool name: exact match + enriched match. Two rules prevent
    // "Read" from matching unrelated "ReadSecret" via a `**` suffix.
    return [
      { pattern: s, action: "invoke" },
      { pattern: `${s}:**`, action: "invoke" },
    ];
  }
  const toolName = s.slice(0, parenIdx);
  const argGlob = s.slice(parenIdx + 1, s.endsWith(")") ? s.length - 1 : s.length);
  if (argGlob === "*") {
    // "ToolName(*)" — any invocation of that tool (exact + enriched, no prefix bleed)
    return [
      { pattern: toolName, action: "invoke" },
      { pattern: `${toolName}:**`, action: "invoke" },
    ];
  }
  // "ToolName(commandGlob)" — encode command constraint in the resource pattern.
  // Middleware enriches tool resources as "ToolName:commandPrefix", so the
  // pattern "ToolName:commandGlob" matches those enriched resource keys.
  return [{ pattern: `${toolName}:${argGlob}`, action: "invoke" }];
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
      for (const { pattern, action } of parsePermissionString(s)) {
        rules.push({ pattern, action, effect, source: layer });
      }
    }
  }

  return rules;
}

/**
 * Result of `widenCommandScopedRulesForTui`.
 * `hadCommandScoped` is true when at least one rule was widened or stripped,
 * so callers can emit a warning without repeating the detection logic.
 */
export interface TuiRuleNormalizationResult {
  readonly rules: readonly SourcedRule[];
  readonly hadCommandScoped: boolean;
}

/**
 * Normalize `SourcedRule[]` for use with the single-key TUI permission backend
 * (`createPermissionBackend`), which never receives enriched `"Tool:command"`
 * resource strings — only plain tool ids.
 *
 * Command-scoped rules (pattern has `":"` but NOT the bare enriched suffix `":**"`)
 * cannot be evaluated as-is by the single-key backend:
 *
 *   deny/ask  → widened to tool-level (`"Bash:rm -rf*"` → `"Bash**"`)
 *               fail-closed: the whole tool is blocked when a command is restricted
 *   allow     → stripped entirely
 *               fail-open widening (`"Bash:git *"` → allow all Bash) would over-permit
 *
 * The enriched-wildcard suffix `":**"` (e.g. `"Read:**"`) is NOT command-scoped —
 * it is the bare-tool enriched pattern emitted by `mapSettingsToSourcedRules` to
 * match any enriched resource for that tool. It passes through unchanged.
 *
 * Rules without `":"` are returned unchanged.
 * Use `koi start` (marker-aware `createPatternPermissionBackend`) for precise
 * command-scoped enforcement without widening.
 */
export function widenCommandScopedRulesForTui(
  rules: readonly SourcedRule[],
): TuiRuleNormalizationResult {
  let hadCommandScoped = false;
  const normalized: SourcedRule[] = [];
  for (const rule of rules) {
    // ":**" suffix is the bare-tool enriched wildcard, not a command-scoped pattern.
    if (!rule.pattern.includes(":") || rule.pattern.endsWith(":**")) {
      normalized.push(rule);
      continue;
    }
    hadCommandScoped = true;
    if (rule.effect === "allow") {
      // Strip: widening a command-scoped allow to the whole tool would over-permit.
      continue;
    }
    // Widen to exact tool match + enriched-wildcard (mirrors bare-tool dual-rule
    // strategy) to avoid prefix bleed: "Bash" must not match "BashScript".
    const toolName = rule.pattern.slice(0, rule.pattern.indexOf(":"));
    normalized.push({ ...rule, pattern: toolName });
    normalized.push({ ...rule, pattern: `${toolName}:**` });
  }
  return { rules: normalized, hadCommandScoped };
}
