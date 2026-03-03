/**
 * Mock component factories for testing.
 *
 * Provides configurable mock implementations of singleton components
 * defined in @koi/core's ECS layer.
 */

import type {
  MemoryComponent,
  MemoryRecallOptions,
  MemoryResult,
  MemoryStoreOptions,
} from "@koi/core";

export interface MockMemoryComponentOptions {
  /** Results to return from recall(). Defaults to empty array. */
  readonly results?: readonly MemoryResult[];
  /** If provided, recall() will throw this error. */
  readonly recallError?: Error;
  /** When set, recall() filters results by namespace metadata before returning. */
  readonly namespaceFilter?: string;
}

export interface RecallCall {
  readonly query: string;
  readonly options?: MemoryRecallOptions;
}

export interface StoreCall {
  readonly content: string;
  readonly options?: MemoryStoreOptions;
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
  readonly recallCalls: readonly RecallCall[];
  readonly storeCalls: readonly StoreCall[];
} {
  const recallCalls: RecallCall[] = [];
  const storeCalls: StoreCall[] = [];
  const results = options?.results ?? [];

  return {
    async recall(
      query: string,
      recallOptions?: MemoryRecallOptions,
    ): Promise<readonly MemoryResult[]> {
      const call: RecallCall =
        recallOptions !== undefined ? { query, options: recallOptions } : { query };
      recallCalls.push(call);
      if (options?.recallError !== undefined) {
        throw options.recallError;
      }
      if (options?.namespaceFilter !== undefined) {
        return results.filter((r) => r.metadata?.namespace === options.namespaceFilter);
      }
      return results;
    },

    async store(content: string, storeOptions?: MemoryStoreOptions): Promise<void> {
      const call: StoreCall =
        storeOptions !== undefined ? { content, options: storeOptions } : { content };
      storeCalls.push(call);
    },

    recallCalls,
    storeCalls,
  };
}
