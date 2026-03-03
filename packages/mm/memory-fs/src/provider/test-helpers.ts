/**
 * Shared test helpers for @koi/memory-fs provider tests.
 */

import type {
  MemoryComponent,
  MemoryRecallOptions,
  MemoryResult,
  MemoryStoreOptions,
} from "@koi/core";
import type { FsMemory, TierDistribution } from "../types.js";

export { createMockAgent } from "@koi/test-utils";

interface MethodCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export function createMockMemoryComponent(): MemoryComponent & {
  readonly calls: readonly MethodCall[];
} {
  const calls: MethodCall[] = [];

  return {
    get calls() {
      return calls;
    },
    store: async (content: string, options?: MemoryStoreOptions): Promise<void> => {
      calls.push({ method: "store", args: [content, options] });
    },
    recall: async (
      query: string,
      options?: MemoryRecallOptions,
    ): Promise<readonly MemoryResult[]> => {
      calls.push({ method: "recall", args: [query, options] });
      return [
        {
          content: `Memory about: ${query}`,
          score: 0.9,
          tier: "hot",
          decayScore: 0.95,
          lastAccessed: new Date().toISOString(),
        },
      ];
    },
  };
}

export function createMockFsMemory(
  component?: MemoryComponent,
): FsMemory & { readonly calls: readonly MethodCall[] } {
  const calls: MethodCall[] = [];
  const comp = component ?? createMockMemoryComponent();

  return {
    get calls() {
      return calls;
    },
    component: comp,
    rebuildSummaries: async (): Promise<void> => {
      calls.push({ method: "rebuildSummaries", args: [] });
    },
    getTierDistribution: async (): Promise<TierDistribution> => {
      calls.push({ method: "getTierDistribution", args: [] });
      return { hot: 3, warm: 2, cold: 1, total: 6 };
    },
    listEntities: async (): Promise<readonly string[]> => {
      calls.push({ method: "listEntities", args: [] });
      return ["alice", "bob", "project-x"];
    },
    close: async (): Promise<void> => {
      calls.push({ method: "close", args: [] });
    },
  };
}
