/**
 * Resolver contract test suite.
 *
 * Validates that any Resolver<TMeta, TFull> implementation satisfies the L0 contract.
 * Usage: import { testResolverContract } from "@koi/test-utils" and call it
 * inside a describe() block with a factory function.
 */

import { expect, test } from "bun:test";
import type { Resolver } from "@koi/core/resolver";
import { assertKoiError } from "./assert-koi-error.js";

export interface ResolverContractOptions<TMeta, TFull> {
  /** Factory that creates a fresh resolver instance for each test. */
  readonly createResolver: () => Resolver<TMeta, TFull> | Promise<Resolver<TMeta, TFull>>;
  /** Items the resolver should be seeded with for testing. */
  readonly seedItems?: readonly TMeta[] | undefined;
  /** Extract the string ID from a metadata object. */
  readonly getId: (meta: TMeta) => string;
}

/**
 * Runs the resolver contract test suite.
 *
 * Call this inside a `describe()` block. It will register tests that verify
 * the resolver satisfies all L0 contract invariants.
 */
export function testResolverContract<TMeta, TFull>(
  options: ResolverContractOptions<TMeta, TFull>,
): void {
  const { createResolver, seedItems, getId } = options;

  // ---------------------------------------------------------------------------
  // discover()
  // ---------------------------------------------------------------------------

  test("discover() returns a readonly array", async () => {
    const resolver = await createResolver();
    const items = await resolver.discover();
    expect(Array.isArray(items)).toBe(true);
  });

  test("discover() may return an empty array", async () => {
    const resolver = await createResolver();
    const items = await resolver.discover();
    // Just verify it's an array — emptiness depends on seeding
    expect(Array.isArray(items)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // load()
  // ---------------------------------------------------------------------------

  test("load() returns error with NOT_FOUND code for unknown ID", async () => {
    const resolver = await createResolver();
    const result = await resolver.load("__nonexistent_id_for_contract_test__");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      assertKoiError(result.error, { code: "NOT_FOUND" });
    }
  });

  test("load() error for unknown ID includes code, message, and retryable", async () => {
    const resolver = await createResolver();
    const result = await resolver.load("__nonexistent_id_for_contract_test__");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error.code).toBe("string");
      expect(typeof result.error.message).toBe("string");
      expect(result.error.message.length).toBeGreaterThan(0);
      expect(typeof result.error.retryable).toBe("boolean");
    }
  });

  // ---------------------------------------------------------------------------
  // Discovered items can be loaded
  // ---------------------------------------------------------------------------

  if (seedItems !== undefined && seedItems.length > 0) {
    test("every discovered item can be loaded successfully", async () => {
      const resolver = await createResolver();
      const discovered = await resolver.discover();

      for (const meta of discovered) {
        const id = getId(meta);
        const result = await resolver.load(id);
        expect(result.ok).toBe(true);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // onChange()
  // ---------------------------------------------------------------------------

  test("onChange() returns an unsubscribe function when provided", async () => {
    const resolver = await createResolver();
    if (resolver.onChange === undefined) return;

    const unsubscribe = resolver.onChange(() => {});
    expect(typeof unsubscribe).toBe("function");
    unsubscribe();
  });

  test("onChange() unsubscribe is idempotent", async () => {
    const resolver = await createResolver();
    if (resolver.onChange === undefined) return;

    const unsubscribe = resolver.onChange(() => {});
    unsubscribe();
    unsubscribe(); // Should not throw on double-call
  });

  // ---------------------------------------------------------------------------
  // source()
  // ---------------------------------------------------------------------------

  test("source() returns error with NOT_FOUND for unknown ID when provided", async () => {
    const resolver = await createResolver();
    if (resolver.source === undefined) return;

    const result = await resolver.source("__nonexistent_id_for_contract_test__");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      assertKoiError(result.error, { code: "NOT_FOUND" });
    }
  });

  test("source() error includes code, message, and retryable", async () => {
    const resolver = await createResolver();
    if (resolver.source === undefined) return;

    const result = await resolver.source("__nonexistent_id_for_contract_test__");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error.code).toBe("string");
      expect(typeof result.error.message).toBe("string");
      expect(typeof result.error.retryable).toBe("boolean");
    }
  });
}
