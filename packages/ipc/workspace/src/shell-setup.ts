/**
 * Shell setup helper for workspace post-create hooks.
 *
 * Convenience factory that creates a postCreate function
 * which runs a shell command in the new workspace directory.
 */

import type { WorkspaceInfo } from "@koi/core";

/**
 * Create a postCreate hook that runs a shell command in the workspace.
 *
 * Validates command at creation time (fail-fast). The returned function
 * spawns the process in the workspace directory.
 *
 * @example
 * ```typescript
 * const provider = createWorkspaceProvider({
 *   backend,
 *   postCreate: createShellSetup("bun", ["install"]),
 * });
 * ```
 */
export function createShellSetup(
  command: string,
  args?: readonly string[],
): (workspace: WorkspaceInfo) => Promise<void> {
  if (!command || command.includes("\0")) {
    throw new Error("createShellSetup: command must be a non-empty string without null bytes");
  }

  return async (workspace: WorkspaceInfo): Promise<void> => {
    const proc = Bun.spawn([command, ...(args ?? [])], {
      cwd: workspace.path,
      stdout: "ignore",
      stderr: "pipe",
    });

    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);

    if (exitCode !== 0) {
      throw new Error(`Shell setup "${command}" failed (exit ${exitCode}): ${stderr.trim()}`);
    }
  };
}
