/**
 * Mock component factories for testing.
 *
 * Provides configurable mock implementations of singleton components
 * defined in @koi/core's ECS layer.
 */

import type { MemoryComponent, MemoryResult } from "@koi/core";

export interface MockMemoryComponentOptions {
  /** Results to return from recall(). Defaults to empty array. */
  readonly results?: readonly MemoryResult[];
  /** If provided, recall() will throw this error. */
  readonly recallError?: Error;
}

/**
 * Creates a mock MemoryComponent for testing.
 *
 * By default returns empty recall results. Configure via options
 * to return specific results or simulate errors.
 *
 * Returns the component plus tracking arrays for assertions.
 */
export function createMockMemoryComponent(options?: MockMemoryComponentOptions): MemoryComponent & {
  readonly recallCalls: readonly string[];
  readonly storeCalls: readonly string[];
} {
  const recallCalls: string[] = [];
  const storeCalls: string[] = [];
  const results = options?.results ?? [];

  return {
    async recall(query: string): Promise<readonly MemoryResult[]> {
      recallCalls.push(query);
      if (options?.recallError !== undefined) {
        throw options.recallError;
      }
      return results;
    },

    async store(content: string): Promise<void> {
      storeCalls.push(content);
    },

    recallCalls,
    storeCalls,
  };
}
