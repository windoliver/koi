/**
 * Hook loader — validates raw config and returns typed HookConfig arrays.
 *
 * Entry point for parsing hook definitions from agent manifests.
 */

import type { HookConfig, KoiError, Result } from "@koi/core";
import { HOOK_EVENT_KINDS } from "@koi/core";
import { validateWith } from "@koi/validation";
import { hookConfigArraySchema } from "./schema.js";

// ---------------------------------------------------------------------------
// Load result with optional warnings
// ---------------------------------------------------------------------------

/** Successful load result including optional warnings for unknown event kinds. */
export interface LoadHooksResult {
  readonly hooks: readonly HookConfig[];
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const knownEvents = new Set<string>(HOOK_EVENT_KINDS);

/** Collect warnings for filter event names not in HOOK_EVENT_KINDS. */
function collectEventWarnings(hooks: readonly HookConfig[]): readonly string[] {
  const warnings: string[] = [];
  for (const hook of hooks) {
    if (hook.filter?.events === undefined) continue;
    for (const event of hook.filter.events) {
      if (!knownEvents.has(event)) {
        warnings.push(
          `Hook "${hook.name}": unknown event kind "${event}" — ` +
            "this event will never fire on the current runtime version. " +
            "Check for typos or ensure your packages are up to date.",
        );
      }
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates an array of raw hook config objects and returns typed `HookConfig[]`.
 *
 * Filters out disabled hooks (enabled === false) from the result.
 *
 * @param raw - Unknown input to validate (typically from parsed YAML/JSON manifest).
 * @returns Result with validated hook configs or a KoiError with schema violation details.
 */
export function loadHooks(raw: unknown): Result<readonly HookConfig[], KoiError> {
  const result = loadHooksInternal(raw);
  if (!result.ok) return result;
  return { ok: true, value: result.value.hooks };
}

/**
 * Like `loadHooks`, but also returns warnings for unknown event kinds in
 * `filter.events`. Unknown events are accepted (forward-compatible) but
 * flagged so typos and version skew are visible at load time.
 *
 * @param raw - Unknown input to validate (typically from parsed YAML/JSON manifest).
 * @returns Result with validated hook configs + warnings, or a KoiError.
 */
export function loadHooksWithDiagnostics(raw: unknown): Result<LoadHooksResult, KoiError> {
  return loadHooksInternal(raw);
}

// ---------------------------------------------------------------------------
// Shared implementation
// ---------------------------------------------------------------------------

function loadHooksInternal(raw: unknown): Result<LoadHooksResult, KoiError> {
  // AgentManifest.hooks is optional — treat undefined/null as empty
  if (raw === undefined || raw === null) {
    return { ok: true, value: { hooks: [], warnings: [] } };
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

  const warnings = collectEventWarnings(active);

  return { ok: true, value: { hooks: active, warnings } };
}
