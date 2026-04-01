/**
 * Forge → Registry sync — publishes promoted bricks to a BrickRegistryWriter.
 *
 * Subscribes to ForgeStore.watch() for "promoted" events and fires
 * registry.register() in a fire-and-forget pattern. Opt-in via factory.
 */

import type { BrickRegistryWriter, ForgeStore } from "@koi/core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ForgeRegistrySyncConfig {
  readonly forgeStore: ForgeStore;
  readonly registry: BrickRegistryWriter;
  /** Called after a brick is successfully published to the registry. */
  readonly onPublished?: (brickId: string, name: string) => void;
  /** Called when loading or registering a promoted brick fails. */
  readonly onError?: (brickId: string, error: unknown) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a sync listener that auto-publishes promoted bricks to a registry.
 *
 * Returns an unsubscribe function. Call it to stop listening.
 * Requires `forgeStore.watch` to be defined — throws otherwise.
 */
export function createForgeRegistrySync(config: ForgeRegistrySyncConfig): () => void {
  const { forgeStore, registry, onPublished, onError } = config;

  if (forgeStore.watch === undefined) {
    throw new Error(
      "ForgeRegistrySync requires a ForgeStore with watch() support. " +
        "The provided store does not implement watch().",
    );
  }

  const unsubscribe = forgeStore.watch((event) => {
    if (event.kind !== "promoted") return;

    const { brickId } = event;

    void (async () => {
      const loadResult = await forgeStore.load(brickId);
      if (!loadResult.ok) {
        onError?.(brickId, new Error(`Failed to load promoted brick: ${loadResult.error.message}`));
        return;
      }

      const registerResult = await registry.register(loadResult.value);
      if (!registerResult.ok) {
        onError?.(brickId, new Error(`Failed to register brick: ${registerResult.error.message}`));
        return;
      }

      onPublished?.(brickId, loadResult.value.name);
    })().catch((e: unknown) => {
      onError?.(brickId, e);
    });
  });

  return unsubscribe;
}
