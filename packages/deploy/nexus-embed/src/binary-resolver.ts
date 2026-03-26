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
    // For "uv run nexus", verify the full command works — not just that "uv" exists.
    // This catches PATH conflicts (e.g. Anaconda's `nexus` shadowing Koi's).
    if (binary === "uv" && binaryParts.includes("nexus")) {
      const proc = Bun.spawn([...binaryParts, "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        if (stderr.includes("No module named") || stderr.includes("ModuleNotFoundError")) {
          process.stderr.write(
            "warn: 'uv run nexus' failed — a conflicting 'nexus' binary may be on your PATH.\n" +
              "hint: Run 'pip uninstall nexus' or set NEXUS_COMMAND to override.\n",
          );
        }
        return false;
      }
      return true;
    }

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
