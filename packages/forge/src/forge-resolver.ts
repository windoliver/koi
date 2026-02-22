/**
 * ForgeResolver — Resolver adapter backed by a ForgeStore.
 * Implements the L0 Resolver<BrickArtifact, BrickArtifact> interface.
 */

import type { KoiError, Resolver, Result } from "@koi/core";
import type { ForgeStore } from "./store.js";
import type { BrickArtifact } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createForgeResolver(store: ForgeStore): Resolver<BrickArtifact, BrickArtifact> {
  const discover = async (): Promise<readonly BrickArtifact[]> => {
    const result = await store.search({});
    if (result.ok) {
      return result.value;
    }
    return [];
  };

  const load = async (id: string): Promise<Result<BrickArtifact, KoiError>> => {
    return store.load(id);
  };

  return { discover, load };
}
