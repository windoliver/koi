import type { KoiError, Result, ToolsetRegistry, ToolsetResolution } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

const MAX_DEPTH = 50;

/**
 * Resolves a named toolset to an explicit policy: "all tools" or an allowlist.
 * Handles recursive `includes` composition with cycle detection.
 *
 * Returns `{ ok: false }` for unknown names, detected cycles, depth limit exceeded,
 * or any composition that inherits a wildcard into a non-wildcard preset.
 *
 * Note: validates toolset names and composition structure only.
 * Does NOT validate that resolved tool names exist in the runtime registry —
 * that is an assembly-time responsibility performed by the caller.
 */
export function resolveToolset(
  name: string,
  registry: ToolsetRegistry,
): Result<ToolsetResolution, KoiError> {
  const memo = new Map<string, Result<ReadonlySet<string>, KoiError>>();
  const inner = resolveToStrings(name, registry, [], memo);
  if (!inner.ok) return inner;

  if (inner.value.has("*")) {
    return { ok: true, value: { mode: "all" } };
  }
  return { ok: true, value: { mode: "allowlist", tools: [...inner.value] } };
}

function resolveToStrings(
  name: string,
  registry: ToolsetRegistry,
  path: readonly string[],
  memo: Map<string, Result<ReadonlySet<string>, KoiError>>,
): Result<ReadonlySet<string>, KoiError> {
  if (path.includes(name)) {
    const cycleStr = [...path, name].join(" → ");
    const error: KoiError = {
      code: "VALIDATION",
      message: `Toolset cycle detected: ${cycleStr}`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
      context: { name, cycle: cycleStr },
    };
    return { ok: false, error };
  }

  if (path.length >= MAX_DEPTH) {
    const error: KoiError = {
      code: "VALIDATION",
      message: `Toolset resolution depth limit (${MAX_DEPTH}) exceeded at "${name}" — reduce composition nesting`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
      context: { name, depth: MAX_DEPTH },
    };
    return { ok: false, error };
  }

  const memoized = memo.get(name);
  if (memoized !== undefined) return memoized;

  const def = registry.get(name);
  if (def === undefined) {
    const error: KoiError = {
      code: "NOT_FOUND",
      message: `Toolset "${name}" not found in registry`,
      retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
      context: { name },
    };
    return { ok: false, error };
  }

  if (def.tools.includes("*") && (def.tools.length > 1 || def.includes.length > 0)) {
    const error: KoiError = {
      code: "VALIDATION",
      message: `Toolset "${name}" uses "*" but it must be the sole tool with no includes — mixing "*" with other tools or includes is not allowed`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
      context: { name },
    };
    return { ok: false, error };
  }

  const nextPath = [...path, name];
  const collected = new Set<string>(def.tools);

  for (const include of def.includes) {
    const inner = resolveToStrings(include, registry, nextPath, memo);
    if (!inner.ok) return inner;
    if (inner.value.has("*")) {
      const error: KoiError = {
        code: "VALIDATION",
        message: `Toolset "${name}" includes "${include}" which resolves to mode:all — inheriting a wildcard preset into a non-wildcard preset is not allowed`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
        context: { name, include },
      };
      return { ok: false, error };
    }
    for (const tool of inner.value) {
      collected.add(tool);
    }
  }

  const result: Result<ReadonlySet<string>, KoiError> = { ok: true, value: collected };
  memo.set(name, result);
  return result;
}
