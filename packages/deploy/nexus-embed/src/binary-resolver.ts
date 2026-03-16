/**
 * Resolve the Nexus binary command.
 *
 * Default: ["uv", "run", "nexus"]
 * Override: NEXUS_COMMAND env var (space-separated, no quoting support).
 * Paths with spaces are not supported — use a wrapper script instead.
 */

/** Resolve the command to run Nexus. Returns array of command parts. */
export function resolveNexusBinary(sourceDir?: string | undefined): readonly string[] {
  const override = process.env.NEXUS_COMMAND;
  if (override && override.trim().length > 0) {
    return override.trim().split(/\s+/);
  }
  if (sourceDir !== undefined) {
    return ["uv", "run", "--directory", sourceDir, "nexus"];
  }
  return ["uv", "run", "nexus"];
}

/** Check if the resolved binary is likely available. */
export async function checkBinaryAvailable(binaryParts: readonly string[]): Promise<boolean> {
  const binary = binaryParts[0];
  if (binary === undefined) return false;

  try {
    const proc = Bun.spawn(["which", binary], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}
