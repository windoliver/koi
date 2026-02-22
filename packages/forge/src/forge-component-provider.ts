/**
 * ForgeComponentProvider — attaches forged tools as components to agents.
 *
 * Implements the L0 ComponentProvider interface. On attach, it discovers all
 * active tool bricks from the ForgeStore and wraps each as an executable Tool
 * that runs in the sandbox.
 */

import type { Agent, ComponentProvider, JsonObject, Tool, ToolDescriptor } from "@koi/core";
import { toolToken } from "@koi/core";
import type { ForgeStore } from "./store.js";
import type { BrickArtifact, SandboxExecutor } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SANDBOX_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Brick → Tool conversion
// ---------------------------------------------------------------------------

function brickToTool(brick: BrickArtifact, executor: SandboxExecutor, timeoutMs: number): Tool {
  const descriptor: ToolDescriptor = {
    name: brick.name,
    description: brick.description,
    inputSchema: brick.inputSchema ?? { type: "object" },
  };

  const execute = async (input: JsonObject): Promise<unknown> => {
    if (brick.implementation === undefined) {
      return {
        ok: false,
        error: {
          code: "NO_IMPLEMENTATION",
          message: `Brick "${brick.name}" has no implementation`,
        },
      };
    }

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
 * Async factory that pre-loads tools from the store, then returns
 * a ComponentProvider whose attach() is already populated.
 *
 * Note: The L0 ComponentProvider.attach() is synchronous, but ForgeStore
 * is async. This factory resolves the async gap by pre-loading tools
 * before returning the provider.
 *
 * The same tool instances are shared across all attach() calls for efficiency.
 * Forged tools are stateless — state lives in the sandbox execution context.
 */
export async function createForgeComponentProviderAsync(
  config: ForgeComponentProviderConfig,
): Promise<ComponentProvider> {
  const timeoutMs = config.sandboxTimeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS;

  // Load all active tool bricks
  const searchResult = await config.store.search({
    kind: "tool",
    lifecycle: "active",
  });

  if (!searchResult.ok) {
    throw new Error(`ForgeComponentProvider: failed to load tools: ${searchResult.error.message}`);
  }

  const tools: Map<string, unknown> = new Map();
  for (const brick of searchResult.value) {
    if (brick.kind === "tool" && brick.implementation !== undefined) {
      const token = toolToken(brick.name);
      const tool = brickToTool(brick, config.executor, timeoutMs);
      tools.set(token as string, tool);
    }
  }

  return {
    name: "forge",
    attach: (_agent: Agent): ReadonlyMap<string, unknown> => {
      return tools;
    },
  };
}

export { brickToTool };
