/**
 * Brick → Tool conversion — shared utility for converting ToolArtifact bricks
 * into executable Tool instances via a sandbox executor.
 *
 * Supports two execution modes:
 * - **With workspace**: passes `ExecutionContext` with workspace/entry paths
 *   to the executor, enabling `import()` for promoted-tier bricks with npm deps.
 * - **Without workspace**: falls back to `new Function()` (existing behavior).
 *
 * Also provides `brickCapabilityFragment` for auto-mapping BrickArtifact.description
 * to the `CapabilityFragment` convention used by self-describing middleware.
 */

import type {
  BrickArtifact,
  CapabilityFragment,
  ExecutionContext,
  JsonObject,
  SandboxExecutor,
  Tool,
  ToolArtifact,
  ToolDescriptor,
} from "@koi/core";
import { DEFAULT_SANDBOX_TIMEOUT_MS } from "./forge-defaults.js";

/**
 * Convert a ToolArtifact into an executable Tool backed by a sandbox executor.
 *
 * @param brick - The tool artifact to convert
 * @param executor - Sandbox executor for the brick's trust tier
 * @param timeoutMs - Execution timeout in milliseconds (default: 5000)
 * @param workspacePath - Optional workspace path for bricks with npm dependencies
 * @param entryPath - Optional entry file path for import()-based execution
 */
export function brickToTool(
  brick: ToolArtifact,
  executor: SandboxExecutor,
  timeoutMs: number = DEFAULT_SANDBOX_TIMEOUT_MS,
  workspacePath?: string,
  entryPath?: string,
): Tool {
  const descriptor: ToolDescriptor = {
    name: brick.name,
    description: brick.description,
    inputSchema: brick.inputSchema,
  };

  // Build execution context when workspace is available
  const executionContext: ExecutionContext | undefined =
    workspacePath !== undefined
      ? { workspacePath, ...(entryPath !== undefined ? { entryPath } : {}) }
      : undefined;

  const execute = async (input: JsonObject): Promise<unknown> => {
    const result = await executor.execute(brick.implementation, input, timeoutMs, executionContext);
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

/**
 * Auto-generates a CapabilityFragment from a BrickArtifact's name and description.
 * Used when converting forged middleware bricks to KoiMiddleware at runtime.
 * Agent updates description by re-forging (new content hash = new brick).
 */
export function brickCapabilityFragment(brick: BrickArtifact): CapabilityFragment {
  return { label: brick.name, description: brick.description };
}
