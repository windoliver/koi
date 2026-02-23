/**
 * ForgeResolver — Resolver adapter backed by a ForgeStore.
 * Implements the L0 Resolver<BrickArtifact, BrickArtifact> interface.
 */

import type {
  BrickArtifact,
  ForgeStore,
  KoiError,
  Resolver,
  Result,
  SourceBundle,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Source extraction — pure function, exhaustive over BrickArtifact union
// ---------------------------------------------------------------------------

export function extractSource(brick: BrickArtifact): SourceBundle {
  const files = brick.files !== undefined ? { files: brick.files } : {};
  switch (brick.kind) {
    case "tool":
      return { content: brick.implementation, language: "typescript", ...files };
    case "skill":
      return { content: brick.content, language: "markdown", ...files };
    case "agent":
      return { content: brick.manifestYaml, language: "yaml", ...files };
    case "composite":
      return { content: JSON.stringify(brick.brickIds, null, 2), language: "json", ...files };
  }
}

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

  const source = async (id: string): Promise<Result<SourceBundle, KoiError>> => {
    const result = await store.load(id);
    if (!result.ok) {
      return result;
    }
    return { ok: true, value: extractSource(result.value) };
  };

  return { discover, load, source };
}
