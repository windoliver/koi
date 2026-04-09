/**
 * Test helpers for @koi/tasks.
 *
 * Reusable fixtures for tests that need controllable failure injection.
 * NOT exported from the package index — only imported by `*.test.ts` files.
 */

import type { Task, TaskBoardStore } from "@koi/core";
import { createMemoryTaskBoardStore } from "./memory-store.js";

export interface FlakyStoreConfig {
  /**
   * Reject the Nth `put()` call (1-based). All other puts succeed.
   *
   * Example: `{ failOnPut: 1 }` fails the very first put, useful for asserting
   * that a mutation with zero successful persists leaves the board unchanged.
   */
  readonly failOnPut?: number;
  /**
   * Reject every put() call AFTER the Nth one succeeds (0-based count of
   * successful calls). Example: `{ failAfterPut: 3 }` lets the first 3 puts
   * succeed, then fails every subsequent call. Useful for simulating a store
   * that degrades mid-batch.
   */
  readonly failAfterPut?: number;
  /**
   * Custom error thrown by the failing put() call. Defaults to a generic
   * "flaky store injected failure" Error.
   */
  readonly putError?: Error;
}

/**
 * Wrap `createMemoryTaskBoardStore()` with controllable failure injection on
 * `put()`. All other methods pass through unchanged. Reusable across any
 * test that needs to simulate a degraded store — e.g. verifying that
 * ManagedTaskBoard's buffer-then-flush semantics prevent split-brain.
 *
 * Counts are closure-local, so each call to `createFlakyStore` gets a fresh
 * tally. The wrapper is thin: construction never fails, only the `put` path
 * can throw.
 */
export function createFlakyStore(config: FlakyStoreConfig = {}): TaskBoardStore {
  const inner = createMemoryTaskBoardStore();
  // let justified: mutable put counter — incremented on every put() call
  let putCount = 0;
  const putError = config.putError ?? new Error("flaky store injected failure");

  const put = (item: Task): void | Promise<void> => {
    putCount += 1;
    if (config.failOnPut !== undefined && putCount === config.failOnPut) {
      throw putError;
    }
    if (config.failAfterPut !== undefined && putCount > config.failAfterPut) {
      throw putError;
    }
    return inner.put(item);
  };

  return {
    get: inner.get,
    put,
    delete: inner.delete,
    list: inner.list,
    nextId: inner.nextId,
    watch: inner.watch,
    reset: inner.reset,
    [Symbol.asyncDispose]: inner[Symbol.asyncDispose].bind(inner),
  };
}
