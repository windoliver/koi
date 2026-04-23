import type { KoiError, Result, ToolsetRegistry, ToolsetResolution } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

/**
 * Resolves a named toolset to an explicit policy: "all tools" or an allowlist.
 * Handles recursive `includes` composition with cycle detection.
 *
 * Returns `{ ok: false }` for unknown names or detected cycles.
 *
 * Note: this function validates toolset names and composition structure only.
 * It does NOT validate that the resolved tool names exist in the runtime registry —
 * that is an assembly-time responsibility performed by the caller with access to the
 * live tool set. Unknown tool names in an allowlist are silently dropped by the engine.
 */
export function resolveToolset(
  name: string,
  registry: ToolsetRegistry,
): Result<ToolsetResolution, KoiError> {
  const inner = resolveToStrings(name, registry, []);
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
    const inner = resolveToStrings(include, registry, nextPath);
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

  return { ok: true, value: collected };
}
