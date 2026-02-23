/**
 * Deep merge utility for config objects.
 *
 * - Recursively merges plain objects.
 * - Arrays are replaced wholesale (not concatenated).
 * - Primitives from the override win.
 * - Returns a new object — never mutates inputs.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deeply merges `override` into `base`, returning a new object.
 *
 * Plain objects are merged recursively. All other values (arrays, primitives)
 * from `override` replace the corresponding `base` value.
 */
export function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(base)) {
    const baseVal = base[key];
    const overrideVal = (override as Record<string, unknown>)[key];

    if (overrideVal === undefined) {
      result[key] = baseVal;
    } else if (isPlainObject(baseVal) && isPlainObject(overrideVal)) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      );
    } else {
      result[key] = overrideVal;
    }
  }

  return result as T;
}
