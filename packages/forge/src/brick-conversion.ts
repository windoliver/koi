/**
 * Brick → Tool conversion — shared utility for converting ToolArtifact bricks
 * into executable Tool instances via a sandbox executor.
 *
 * Also provides `brickCapabilityFragment` for auto-mapping BrickArtifact.description
 * to the `CapabilityFragment` convention used by self-describing middleware.
 */

import type {
  BrickArtifact,
  CapabilityFragment,
  JsonObject,
  SandboxExecutor,
  Tool,
  ToolArtifact,
  ToolDescriptor,
} from "@koi/core";

const DEFAULT_SANDBOX_TIMEOUT_MS = 5_000;

/**
 * Convert a ToolArtifact into an executable Tool backed by a sandbox executor.
 *
 * @param brick - The tool artifact to convert
 * @param executor - Sandbox executor for the brick's trust tier
 * @param timeoutMs - Execution timeout in milliseconds (default: 5000)
 */
export function brickToTool(
  brick: ToolArtifact,
  executor: SandboxExecutor,
  timeoutMs: number = DEFAULT_SANDBOX_TIMEOUT_MS,
): Tool {
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

/**
 * Auto-generates a CapabilityFragment from a BrickArtifact's name and description.
 * Used when converting forged middleware bricks to KoiMiddleware at runtime.
 * Agent updates description by re-forging (new content hash = new brick).
 */
export function brickCapabilityFragment(brick: BrickArtifact): CapabilityFragment {
  return { label: brick.name, description: brick.description };
}
