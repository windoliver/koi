import type { KoiSettings } from "@koi/settings";
import type { RuleEffect, RuleSource, SourcedRule } from "./rule-types.js";

/**
 * Parse a settings permission string like "Bash(git push*)" into
 * pattern + action components.
 *
 * Format: "ToolName(actionGlob)" or bare "ToolName" or "*"
 *   "Read(*)"        → { pattern: "Read",    action: "*"       }
 *   "Bash(git push*)"→ { pattern: "Bash",    action: "git push*" }
 *   "WebFetch"       → { pattern: "WebFetch",action: "*"       }
 *   "*"              → { pattern: "*",        action: "*"       }
 */
function parsePermissionString(s: string): { readonly pattern: string; readonly action: string } {
  const parenIdx = s.indexOf("(");
  if (parenIdx === -1) {
    return { pattern: s, action: "*" };
  }
  const pattern = s.slice(0, parenIdx);
  const action = s.slice(parenIdx + 1, s.endsWith(")") ? s.length - 1 : s.length);
  return { pattern, action };
}

/**
 * Convert `KoiSettings.permissions` string arrays into `SourcedRule[]`
 * for use with `createPermissionBackend`.
 *
 * Rules are emitted in order: allow, ask, deny — within each effect bucket,
 * order matches the settings array.
 */
export function mapSettingsToSourcedRules(
  settings: KoiSettings,
  layer: RuleSource,
): readonly SourcedRule[] {
  const perms = settings.permissions;
  if (perms == null) return [];

  const buckets: ReadonlyArray<{
    readonly strings: readonly string[] | undefined;
    readonly effect: RuleEffect;
  }> = [
    { strings: perms.allow, effect: "allow" },
    { strings: perms.ask, effect: "ask" },
    { strings: perms.deny, effect: "deny" },
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
