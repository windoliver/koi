/**
 * Rule loading utilities — parse YAML strings or files into compiled rulesets.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import { validateEventRulesConfig } from "./rule-schema.js";
import type { CompiledRuleset } from "./types.js";

/**
 * Parses a YAML string into a compiled ruleset.
 *
 * @param yaml - YAML string containing event rules config.
 * @returns Compiled ruleset or validation error.
 */
export function loadRulesFromString(yaml: string): Result<CompiledRuleset, KoiError> {
  // let justified: Bun.YAML.parse may throw, need catch
  let parsed: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
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

/**
 * Loads and compiles event rules from a YAML file.
 *
 * @param filePath - Path to the YAML file.
 * @returns Compiled ruleset or error.
 */
export async function loadRulesFromFile(
  filePath: string,
): Promise<Result<CompiledRuleset, KoiError>> {
  // let justified: Bun.file().text() may throw
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
