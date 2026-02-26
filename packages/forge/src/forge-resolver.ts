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
import { brickId } from "@koi/core";
import { filterByAgentScope, isVisibleToAgent } from "./scope-filter.js";

// ---------------------------------------------------------------------------
// Source extraction — pure function, exhaustive over BrickArtifact union
// ---------------------------------------------------------------------------

export function extractSource(brick: BrickArtifact): SourceBundle {
  const files = brick.files !== undefined ? { files: brick.files } : {};
  switch (brick.kind) {
    case "tool":
    case "middleware":
    case "channel":
      return { content: brick.implementation, language: "typescript", ...files };
    case "skill":
      return { content: brick.content, language: "markdown", ...files };
    case "agent":
      return { content: brick.manifestYaml, language: "yaml", ...files };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ForgeResolverContext {
  readonly agentId: string;
}

/**
 * Returns NOT_FOUND if the brick exists but is not visible to the caller.
 * This avoids leaking brick existence to unauthorized agents.
 */
function notFoundError(id: string): Result<never, KoiError> {
  return {
    ok: false,
    error: { code: "NOT_FOUND", message: `Brick not found: ${id}`, retryable: false },
  };
}

export function createForgeResolver(
  store: ForgeStore,
  context: ForgeResolverContext,
): Resolver<BrickArtifact, BrickArtifact> {
  if (!context.agentId) {
    throw new Error("ForgeResolver requires a non-empty agentId in context");
  }
  const { agentId } = context;

  const discover = async (): Promise<readonly BrickArtifact[]> => {
    const result = await store.search({});
    if (!result.ok) {
      throw new Error(`ForgeResolver: store search failed: ${result.error.message}`, {
        cause: result.error,
      });
    }
    return filterByAgentScope(result.value, agentId);
  };

  const load = async (id: string): Promise<Result<BrickArtifact, KoiError>> => {
    const result = await store.load(brickId(id));
    if (!result.ok) return result;
    if (!isVisibleToAgent(result.value, agentId)) return notFoundError(id);
    return result;
  };

  const source = async (id: string): Promise<Result<SourceBundle, KoiError>> => {
    const result = await store.load(brickId(id));
    if (!result.ok) return result;
    if (!isVisibleToAgent(result.value, agentId)) return notFoundError(id);
    return { ok: true, value: extractSource(result.value) };
  };

  const onChange =
    store.watch !== undefined
      ? (listener: () => void): (() => void) => store.watch?.((_event) => listener()) ?? (() => {})
      : undefined;

  return { discover, load, source, ...(onChange !== undefined ? { onChange } : {}) };
}
