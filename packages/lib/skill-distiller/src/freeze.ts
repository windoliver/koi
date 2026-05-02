// Recursively freeze every reachable object so callers holding the reference
// cannot mutate stored state through it. TypeScript `readonly` is erased at
// runtime, so this is the only enforcement point inside the trust boundary.
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value as object)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
