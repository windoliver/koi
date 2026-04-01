/**
 * Immutable deep merge with prototype pollution prevention.
 */

const DANGEROUS_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively merges `override` into `base`, returning a new object.
 *
 * - Objects are merged recursively; override wins on conflict.
 * - Arrays are replaced wholesale (not concatenated).
 * - Primitive values in override replace base values.
 * - Dangerous keys (__proto__, constructor, prototype) are filtered out.
 */
export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Readonly<Record<string, unknown>>,
): T {
  const result: Record<string, unknown> = { ...base };

  for (const key of Object.keys(override)) {
    if (DANGEROUS_KEYS.has(key)) {
      continue;
    }

    const baseVal = result[key];
    const overrideVal = override[key];

    if (isPlainObject(baseVal) && isPlainObject(overrideVal)) {
      result[key] = deepMerge(baseVal as Record<string, unknown>, overrideVal);
    } else {
      result[key] = overrideVal;
    }
  }

  return result as T;
}
