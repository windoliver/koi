import type { KoiError, Result, ToolsetRegistry } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

/**
 * Resolves a named toolset to a flat, deduplicated list of tool names.
 * Handles recursive `includes` composition with cycle detection.
 *
 * Returns `{ ok: false }` for unknown names or detected cycles.
 */
export function resolveToolset(
  name: string,
  registry: ToolsetRegistry,
): Result<readonly string[], KoiError> {
  return resolveWithPath(name, registry, []);
}

function resolveWithPath(
  name: string,
  registry: ToolsetRegistry,
  path: readonly string[],
): Result<readonly string[], KoiError> {
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

  const nextPath = [...path, name];
  const collected = new Set<string>(def.tools);

  for (const include of def.includes) {
    const inner = resolveWithPath(include, registry, nextPath);
    if (!inner.ok) return inner;
    for (const tool of inner.value) {
      collected.add(tool);
    }
  }

  return { ok: true, value: [...collected] };
}
