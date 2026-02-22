/**
 * ForgeComponentProvider — attaches forged tools as components to agents.
 *
 * Implements the L0 ComponentProvider interface. On first attach(), it discovers
 * all active tool bricks from the ForgeStore and wraps each as an executable
 * Tool that runs in the sandbox. Results are cached for subsequent attach() calls.
 *
 * Lazy loading (decision 13A): tools are loaded on first attach(), not at creation.
 */

import type {
  Agent,
  ComponentProvider,
  ForgeStore,
  JsonObject,
  Tool,
  ToolArtifact,
  ToolDescriptor,
} from "@koi/core";
import { toolToken } from "@koi/core";
import type { SandboxExecutor } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SANDBOX_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Brick → Tool conversion
// ---------------------------------------------------------------------------

function brickToTool(brick: ToolArtifact, executor: SandboxExecutor, timeoutMs: number): Tool {
  const descriptor: ToolDescriptor = {
    name: brick.name,
    description: brick.description,
    inputSchema: brick.inputSchema,
  };

  const execute = async (input: JsonObject): Promise<unknown> => {
    const result = await executor.execute(brick.implementation, input, timeoutMs);
    if (!result.ok) {
      return {
        ok: false,
        error: {
          code: result.error.code,
          message: `Forged tool "${brick.name}" failed: ${result.error.message}`,
        },
      };
    }
    return result.value.output;
  };

  return {
    descriptor,
    trustTier: brick.trustTier,
    execute,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ForgeComponentProviderConfig {
  readonly store: ForgeStore;
  readonly executor: SandboxExecutor;
  readonly sandboxTimeoutMs?: number;
}

/**
 * Extended ComponentProvider with cache invalidation support.
 * Call `invalidate()` after store mutations (save/remove/update) to ensure
 * the next `attach()` re-queries the store for fresh data.
 */
export interface ForgeComponentProviderInstance extends ComponentProvider {
  /** Clears the cached tool set. Next `attach()` will re-query the store. */
  readonly invalidate: () => void;
}

/**
 * Creates a ComponentProvider that lazily loads forged tools on first attach().
 * Results are cached — subsequent attach() calls return the same tool instances.
 * Call `invalidate()` to clear the cache after store mutations.
 */
export function createForgeComponentProvider(
  config: ForgeComponentProviderConfig,
): ForgeComponentProviderInstance {
  const timeoutMs = config.sandboxTimeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS;
  let cached: ReadonlyMap<string, unknown> | undefined;

  return {
    name: "forge",
    attach: async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      if (cached !== undefined) {
        return cached;
      }

      const searchResult = await config.store.search({
        kind: "tool",
        lifecycle: "active",
      });

      if (!searchResult.ok) {
        throw new Error(
          `ForgeComponentProvider: failed to load tools: ${searchResult.error.message}`,
          { cause: searchResult.error },
        );
      }

      const tools: Map<string, unknown> = new Map();
      for (const brick of searchResult.value) {
        if (brick.kind === "tool") {
          const token = toolToken(brick.name);
          const tool = brickToTool(brick, config.executor, timeoutMs);
          tools.set(token as string, tool);
        }
      }

      cached = tools;
      return cached;
    },
    invalidate: (): void => {
      cached = undefined;
    },
  };
}

/**
 * @deprecated Use `createForgeComponentProvider` instead (lazy, synchronous factory).
 * Kept for backward compatibility — now delegates to the lazy version.
 */
export async function createForgeComponentProviderAsync(
  config: ForgeComponentProviderConfig,
): Promise<ComponentProvider> {
  return createForgeComponentProvider(config);
}

export { brickToTool };
