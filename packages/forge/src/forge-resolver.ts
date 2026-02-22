/**
 * ForgeResolver — Resolver adapter backed by a ForgeStore.
 * Implements the L0 Resolver<BrickArtifact, BrickArtifact> interface.
 */

import type { BrickArtifact, ForgeStore, KoiError, Resolver, Result } from "@koi/core";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createForgeResolver(store: ForgeStore): Resolver<BrickArtifact, BrickArtifact> {
  const discover = async (): Promise<readonly BrickArtifact[]> => {
    const result = await store.search({});
    if (!result.ok) {
      throw new Error(`ForgeResolver: store search failed: ${result.error.message}`, {
        cause: result.error,
      });
    }
    return result.value;
  };

  const load = async (id: string): Promise<Result<BrickArtifact, KoiError>> => {
    return store.load(id);
  };

  return { discover, load };
}
