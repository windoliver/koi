/**
 * Rule registry — all built-in scan rules.
 */

import type { ScanCategory, ScanRule } from "../types.js";
import { dangerousApisRule } from "./dangerous-apis.js";
import { credentialEnvReferenceRule, destructiveShellProseRule } from "./dangerous-prose.js";
import { exfiltrationRule } from "./exfiltration.js";
import { filesystemAbuseRule } from "./filesystem-abuse.js";
import { nlInjectionRule } from "./nl-injection.js";
import { obfuscationRule } from "./obfuscation.js";
import { promptInjectionRule } from "./prompt-injection.js";
import { prototypePollutionRule } from "./prototype-pollution.js";
import { secretsRule } from "./secrets.js";
import { ssrfRule } from "./ssrf.js";

const ALL_RULES: readonly ScanRule[] = [
  dangerousApisRule,
  obfuscationRule,
  exfiltrationRule,
  prototypePollutionRule,
  filesystemAbuseRule,
  ssrfRule,
  secretsRule,
];

/** Text-based rules run on full markdown in scanSkill(), not on code blocks. */
const TEXT_RULES: readonly ScanRule[] = [
  promptInjectionRule,
  destructiveShellProseRule,
  credentialEnvReferenceRule,
];

/** Server-side only rules — disabled locally, enabled in community registry publish gate. */
const SERVER_RULES: readonly ScanRule[] = [nlInjectionRule];

export function getBuiltinRules(): readonly ScanRule[] {
  return ALL_RULES;
}

export function getTextRules(): readonly ScanRule[] {
  return TEXT_RULES;
}

const ALL_AND_TEXT_RULES: readonly ScanRule[] = [...ALL_RULES, ...TEXT_RULES];

export function getRulesByCategory(category: ScanCategory): readonly ScanRule[] {
  return ALL_AND_TEXT_RULES.filter((r) => r.category === category);
}

/** Server-side rules for community registry publish gate. */
export function getServerRules(): readonly ScanRule[] {
  return SERVER_RULES;
}
