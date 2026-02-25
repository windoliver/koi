/**
 * ForgeRuntime factory — creates a live forge runtime backed by a ForgeStore.
 *
 * Enables hot-attach: forged tools become available mid-session without
 * requiring agent re-assembly. Caches name→ToolArtifact for O(1) lookups,
 * invalidated on store onChange.
 */

import type { ForgeStore, StoreChangeEvent, Tool, ToolArtifact, ToolDescriptor } from "@koi/core";
import { brickToTool } from "./brick-conversion.js";
import type { TieredSandboxExecutor } from "./types.js";

// Re-use the ForgeRuntime interface from L1 types.
// Import it as a type-only import to avoid L2→L1 dependency.
// The factory returns a structurally compatible object.

const DEFAULT_SANDBOX_TIMEOUT_MS = 5_000;

/** Safety cap — catches leaked listeners before they accumulate unboundedly. */
const MAX_EXTERNAL_LISTENERS = 64;

export interface CreateForgeRuntimeOptions {
  readonly store: ForgeStore;
  readonly executor: TieredSandboxExecutor;
  readonly sandboxTimeoutMs?: number;
}

/**
 * ForgeRuntime shape — structurally matches the L1 ForgeRuntime interface.
 * Declared locally to avoid importing from @koi/engine (L2 must not import L1).
 */
export interface ForgeRuntimeInstance {
  readonly resolveTool: (toolId: string) => Promise<Tool | undefined>;
  readonly toolDescriptors: () => Promise<readonly ToolDescriptor[]>;
  readonly watch?: (listener: (event: StoreChangeEvent) => void) => () => void;
  /** Clean up internal store subscription and external listeners. */
  readonly dispose?: () => void;
}

/**
 * Creates a ForgeRuntime backed by a ForgeStore.
 *
 * - Caches active tool artifacts in a name→ToolArtifact Map
 * - Invalidates cache on store.watch notifications
 * - Provides onChange pass-through from the underlying store
 */
export function createForgeRuntime(options: CreateForgeRuntimeOptions): ForgeRuntimeInstance {
  const { store, executor, sandboxTimeoutMs = DEFAULT_SANDBOX_TIMEOUT_MS } = options;

  // let justified: mutable cache invalidated by store.watch
  let cachedTools: ReadonlyMap<string, ToolArtifact> | undefined;

  async function ensureCache(): Promise<ReadonlyMap<string, ToolArtifact>> {
    if (cachedTools !== undefined) {
      return cachedTools;
    }

    const result = await store.search({ kind: "tool", lifecycle: "active" });
    if (!result.ok) {
      // Graceful degradation: return empty map on search failure
      return new Map();
    }

    const tools = new Map<string, ToolArtifact>();
    for (const brick of result.value) {
      if (brick.kind === "tool") {
        tools.set(brick.name, brick);
      }
    }
    cachedTools = tools;
    return cachedTools;
  }

  function invalidateCache(): void {
    cachedTools = undefined;
  }

  const resolveTool = async (toolId: string): Promise<Tool | undefined> => {
    const tools = await ensureCache();
    const artifact = tools.get(toolId);
    if (artifact === undefined) {
      return undefined;
    }
    const { executor: tierExecutor } = executor.forTier(artifact.trustTier);
    return brickToTool(artifact, tierExecutor, sandboxTimeoutMs);
  };

  const toolDescriptors = async (): Promise<readonly ToolDescriptor[]> => {
    const tools = await ensureCache();
    const descriptors: ToolDescriptor[] = [];
    for (const artifact of tools.values()) {
      descriptors.push({
        name: artifact.name,
        description: artifact.description,
        inputSchema: artifact.inputSchema,
      });
    }
    return descriptors;
  };

  // Self-subscribe to store.watch for automatic cache invalidation.
  // External listeners registered via watch() also get notified.
  const externalListeners = new Set<(event: StoreChangeEvent) => void>();

  // let justified: mutable unsubscribe handle for store subscription cleanup
  let unsubStore: (() => void) | undefined;
  if (store.watch !== undefined) {
    unsubStore = store.watch((event) => {
      invalidateCache();
      // Snapshot to avoid issues if a listener unsubscribes during iteration
      const snapshot = [...externalListeners];
      for (const listener of snapshot) {
        try {
          listener(event);
        } catch (_: unknown) {
          // Never let one listener break others — silently continue
        }
      }
    });
  }

  const watch =
    store.watch !== undefined
      ? (listener: (event: StoreChangeEvent) => void): (() => void) => {
          if (externalListeners.size >= MAX_EXTERNAL_LISTENERS) {
            throw new Error(
              `ForgeRuntime: external listener limit (${String(MAX_EXTERNAL_LISTENERS)}) reached — likely a listener leak. ` +
                `Ensure returned unsubscribe functions are called.`,
            );
          }
          externalListeners.add(listener);
          return () => {
            externalListeners.delete(listener);
          };
        }
      : undefined;

  const dispose = (): void => {
    if (unsubStore !== undefined) {
      unsubStore();
      unsubStore = undefined;
    }
    externalListeners.clear();
    invalidateCache();
    store.dispose?.();
  };

  return {
    resolveTool,
    toolDescriptors,
    ...(watch !== undefined ? { watch } : {}),
    dispose,
  };
}
