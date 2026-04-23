import type { ToolsetResolution } from "@koi/core";

/**
 * Converts a `ToolsetResolution` to the value expected by `SpawnRequest.toolAllowlist`.
 *
 * - `{ mode: "all" }` → `undefined` (no filter — agent receives every tool)
 * - `{ mode: "allowlist", tools }` → `tools` (explicit allowlist)
 *
 * Example:
 * ```typescript
 * const result = resolveToolset("safe", reg);
 * if (result.ok) {
 *   await spawn({ ...req, toolAllowlist: resolutionToToolAllowlist(result.value) });
 * }
 * ```
 */
export function resolutionToToolAllowlist(
  resolution: ToolsetResolution,
): readonly string[] | undefined {
  if (resolution.mode === "all") return undefined;
  return resolution.tools;
}
