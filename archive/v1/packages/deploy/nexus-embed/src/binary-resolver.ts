/**
 * Resolve the Nexus binary command.
 *
 * Default: ["uvx", "--from", "nexus-ai-fs", "nexus"]
 * Source dir: ["uv", "run", "--directory", sourceDir, "nexus"]
 * Override: NEXUS_COMMAND env var (space-separated, no quoting support).
 * Paths with spaces are not supported — use a wrapper script instead.
 *
 * Uses `uvx` instead of `uv run` to avoid PATH conflicts with other packages
 * that install a `nexus` binary (e.g., Anaconda). `uvx` runs in an isolated
 * temporary environment, so the system PATH is irrelevant.
 */

/** Resolve the command to run Nexus. Returns array of command parts. */
export function resolveNexusBinary(sourceDir?: string | undefined): readonly string[] {
  const override = process.env.NEXUS_COMMAND;
  if (override && override.trim().length > 0) {
    return override.trim().split(/\s+/);
  }
  // Source-dir mode: run from the local nexus repo (for contributors).
  // Uses `uv run --directory` which resolves within the project's pyproject.toml.
  if (sourceDir !== undefined) {
    return ["uv", "run", "--directory", sourceDir, "nexus"];
  }
  // Default: use `uvx` for isolated execution. Avoids PATH conflicts with
  // other packages that install a `nexus` binary (e.g., Anaconda).
  return ["uvx", "--from", "nexus-ai-fs", "nexus"];
}

/** Check if the resolved binary is likely available. */
export async function checkBinaryAvailable(binaryParts: readonly string[]): Promise<boolean> {
  const binary = binaryParts[0];
  if (binary === undefined) return false;

  try {
    // For uvx/uv commands, verify the full command works — not just that the binary exists.
    if ((binary === "uvx" || binary === "uv") && binaryParts.includes("nexus")) {
      const proc = Bun.spawn([...binaryParts, "--version"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        if (stderr.includes("No module named") || stderr.includes("ModuleNotFoundError")) {
          process.stderr.write(
            "warn: nexus CLI resolution failed — a conflicting 'nexus' binary may be on your PATH.\n" +
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
