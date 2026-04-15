/**
 * Hook loader — validates raw config and returns typed HookConfig arrays.
 *
 * Entry point for parsing hook definitions from agent manifests.
 */

import type { HookConfig, KoiError, Result } from "@koi/core";
import { HOOK_EVENT_KINDS } from "@koi/core";
import { validateWith } from "@koi/validation";
import type { HookTier, RegisteredHook } from "./policy.js";
import { createRegisteredHooks } from "./policy.js";
import { hookConfigArraySchema, hookConfigSchema } from "./schema.js";

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
          `Hook "${hook.name}": "${event}" is not in the built-in event set. ` +
            "Check for typos, or ignore if this is a custom/third-party event.",
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
  const active = result.value.filter((hook: HookConfig) => hook.enabled !== false);

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

// ---------------------------------------------------------------------------
// Registered hooks loader — validates + tags with tier
// ---------------------------------------------------------------------------

/** Successful load result for registered hooks including optional warnings. */
export interface LoadRegisteredHooksResult {
  readonly hooks: readonly RegisteredHook[];
  readonly warnings: readonly string[];
}

/**
 * Validates raw hook config and returns `RegisteredHook[]` tagged with the given tier.
 *
 * Combines `loadHooks` validation with `createRegisteredHooks` tagging.
 */
export function loadRegisteredHooks(
  raw: unknown,
  tier: HookTier,
): Result<readonly RegisteredHook[], KoiError> {
  const result = loadHooksInternal(raw);
  if (!result.ok) return result;
  return { ok: true, value: createRegisteredHooks(result.value.hooks, tier) };
}

/**
 * Like `loadRegisteredHooks`, but also returns warnings for unknown event kinds.
 */
export function loadRegisteredHooksWithDiagnostics(
  raw: unknown,
  tier: HookTier,
): Result<LoadRegisteredHooksResult, KoiError> {
  const result = loadHooksInternal(raw);
  if (!result.ok) return result;
  return {
    ok: true,
    value: {
      hooks: createRegisteredHooks(result.value.hooks, tier),
      warnings: result.value.warnings,
    },
  };
}

// ---------------------------------------------------------------------------
// Per-entry registered hooks loader — valid entries load even when peers fail
// ---------------------------------------------------------------------------

/**
 * A loader error scoped to a single hook entry (or `-1` for structural errors
 * like "not an array"). Carries the hook's declared `name` when parseable so
 * operators can identify which entry failed without counting array indices.
 *
 * `failClosed` is sniffed from the raw entry independently of schema
 * validation: if the operator explicitly marked an entry `failClosed: true`
 * they have declared that hook load-critical, so callers can fail startup on
 * that error even when the rest of the schema is invalid. Absent field or a
 * non-boolean value → `failClosed` is `undefined` (best-effort partial load
 * is acceptable).
 */
export interface HookLoadError {
  readonly index: number;
  readonly name?: string;
  readonly message: string;
  readonly failClosed?: boolean;
}

/** Result of per-entry hook loading: valid entries + per-entry errors + warnings. */
export interface LoadRegisteredHooksPerEntryResult {
  readonly hooks: readonly RegisteredHook[];
  readonly errors: readonly HookLoadError[];
  readonly warnings: readonly string[];
}

/**
 * Per-entry variant of `loadRegisteredHooks`: validates each array element
 * independently so one malformed hook does not discard its valid peers.
 *
 * Differences from `loadRegisteredHooks`:
 * - Invalid entries are collected into `errors` (with index + declared name
 *   when available) instead of rejecting the whole array.
 * - Duplicate names are reported per-entry (first occurrence wins).
 * - A non-array root is reported as a single error with `index: -1`.
 *
 * Callers (CLI, TUI, daemons) should surface `errors` via whatever operator
 * channel they have — `loadRegisteredHooks`'s all-or-nothing Result is kept
 * for strict callers (schema validators, CI).
 */
export function loadRegisteredHooksPerEntry(
  raw: unknown,
  tier: HookTier,
): LoadRegisteredHooksPerEntryResult {
  if (raw === undefined || raw === null) {
    return { hooks: [], errors: [], warnings: [] };
  }
  if (!Array.isArray(raw)) {
    return {
      hooks: [],
      errors: [
        {
          index: -1,
          message: "Hook config must be an array of hook entries",
        },
      ],
      warnings: [],
    };
  }

  const accepted: HookConfig[] = [];
  const errors: HookLoadError[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i];
    const parsed = validateWith(hookConfigSchema, entry, `Hook[${i}] validation failed`);
    if (!parsed.ok) {
      const rawEntry =
        typeof entry === "object" && entry !== null
          ? (entry as { readonly name?: unknown; readonly failClosed?: unknown })
          : undefined;
      const rawName = rawEntry?.name;
      const rawFailClosed = rawEntry?.failClosed;
      errors.push({
        index: i,
        message: parsed.error.message,
        ...(typeof rawName === "string" && rawName.length > 0 ? { name: rawName } : {}),
        ...(typeof rawFailClosed === "boolean" ? { failClosed: rawFailClosed } : {}),
      });
      continue;
    }

    const hook = parsed.value;
    if (hook.enabled === false) continue;

    if (seen.has(hook.name)) {
      errors.push({
        index: i,
        name: hook.name,
        message: `Duplicate hook name "${hook.name}" — first occurrence kept, this entry skipped`,
      });
      continue;
    }
    seen.add(hook.name);
    accepted.push(hook);
  }

  const warnings = collectEventWarnings(accepted);
  return {
    hooks: createRegisteredHooks(accepted, tier),
    errors,
    warnings,
  };
}
