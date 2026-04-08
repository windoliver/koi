/**
 * Variable substitution for skill body templates.
 *
 * Replaces known `${VAR}` placeholders with runtime values.
 * Unknown variables are left as-is (no error).
 */

import type { SkillVariables } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VAR_PATTERN = /\$\{(\w+)\}/g;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Substitutes known variables in a skill body template.
 *
 * Supported variables:
 * - `${ARGS}` — tool invocation args (empty string when absent)
 * - `${SKILL_DIR}` — absolute path to the skill's directory
 * - `${SESSION_ID}` — current session identifier (empty string when absent)
 *
 * Unknown `${...}` patterns are left as-is.
 */
export function substituteVariables(body: string, vars: SkillVariables): string {
  const map: Record<string, string> = {
    SKILL_DIR: vars.skillDir,
  };
  // Only add optional variables when explicitly provided.
  // Unset variables are left as-is (${ARGS} stays literal when no args given).
  if (vars.args !== undefined) {
    map.ARGS = vars.args;
  }
  if (vars.sessionId !== undefined) {
    map.SESSION_ID = vars.sessionId;
  }
  return body.replace(VAR_PATTERN, (match: string, key: string) => map[key] ?? match);
}
