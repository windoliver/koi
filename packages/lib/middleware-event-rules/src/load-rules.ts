/**
 * Rule loading utilities — parse YAML strings or files into compiled rulesets.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import { validateEventRulesConfig } from "./rule-schema.js";
import type { CompiledRuleset } from "./types.js";

export function loadRulesFromString(yaml: string): Result<CompiledRuleset, KoiError> {
  // let justified: try/catch capture
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(yaml);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Failed to parse YAML: ${msg}`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }
  return validateEventRulesConfig(parsed);
}

export async function loadRulesFromFile(
  filePath: string,
): Promise<Result<CompiledRuleset, KoiError>> {
  // let justified: try/catch capture
  let content: string;
  try {
    content = await Bun.file(filePath).text();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Failed to read rules file '${filePath}': ${msg}`,
        retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
      },
    };
  }
  return loadRulesFromString(content);
}
