/**
 * Hook loader — validates raw config and returns typed HookConfig arrays.
 *
 * Entry point for parsing hook definitions from agent manifests.
 */

import type { HookConfig, KoiError, Result } from "@koi/core";
import { validateWith } from "@koi/validation";
import { hookConfigArraySchema } from "./schema.js";

/**
 * Validates an array of raw hook config objects and returns typed `HookConfig[]`.
 *
 * Filters out disabled hooks (enabled === false) from the result.
 *
 * @param raw - Unknown input to validate (typically from parsed YAML/JSON manifest).
 * @returns Result with validated hook configs or a KoiError with schema violation details.
 */
export function loadHooks(raw: unknown): Result<readonly HookConfig[], KoiError> {
  // AgentManifest.hooks is optional — treat undefined/null as empty
  if (raw === undefined || raw === null) {
    return { ok: true, value: [] };
  }

  const result = validateWith(hookConfigArraySchema, raw, "Hook config validation failed");
  if (!result.ok) {
    return result;
  }

  // Filter out explicitly disabled hooks
  const active = result.value.filter((hook) => hook.enabled !== false);

  // Reject duplicate hook names among active hooks
  const seen = new Set<string>();
  for (const hook of active) {
    if (seen.has(hook.name)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Hook config validation failed: duplicate hook name "${hook.name}"`,
          retryable: false,
          context: { duplicateName: hook.name },
        },
      };
    }
    seen.add(hook.name);
  }

  return { ok: true, value: active };
}
