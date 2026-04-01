/**
 * Self-test: validates the Nexus namespace contract test suite
 * using a simple in-memory adapter.
 */

import type { KoiError, Result } from "@koi/core";
import type { NexusStoreAdapter } from "./nexus-store-contract.js";
import { runNexusStoreContractTests } from "./nexus-store-contract.js";

/** In-memory adapter for testing the contract suite itself. */
function createInMemoryAdapter(): NexusStoreAdapter {
  const store = new Map<string, string>();

  return {
    write: async (path, content): Promise<Result<void, KoiError>> => {
      store.set(path, content);
      return { ok: true, value: undefined };
    },
    read: async (path): Promise<Result<string, KoiError>> => {
      const content = store.get(path);
      if (content === undefined) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Not found: ${path}`, retryable: false },
        };
      }
      return { ok: true, value: content };
    },
    remove: async (path): Promise<Result<void, KoiError>> => {
      store.delete(path);
      return { ok: true, value: undefined };
    },
    glob: async (pattern): Promise<Result<readonly string[], KoiError>> => {
      // Simple glob: convert "foo/bar/*.json" to regex
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`^${escaped.replace(/\*/g, "[^/]*")}$`);
      const matches = [...store.keys()].filter((k) => regex.test(k));
      return { ok: true, value: matches };
    },
  };
}

runNexusStoreContractTests(() => createInMemoryAdapter());
