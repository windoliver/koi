/**
 * Generic factory helper for test fixtures.
 *
 * Creates a factory function that returns a new object from defaults,
 * merged with optional overrides. Eliminates repeated
 * `{ ...DEFAULT, ...overrides }` patterns across test suites.
 */

/**
 * Create a factory function that produces `T` instances from defaults + overrides.
 *
 * @example
 * ```ts
 * const createUser = createFactory({ name: "Alice", age: 30 });
 * const user = createUser({ age: 25 }); // { name: "Alice", age: 25 }
 * ```
 */
export function createFactory<T extends object>(defaults: T): (overrides?: Partial<T>) => T {
  return (overrides?: Partial<T>): T => {
    if (overrides === undefined) {
      return { ...defaults };
    }
    return { ...defaults, ...overrides } as T;
  };
}
