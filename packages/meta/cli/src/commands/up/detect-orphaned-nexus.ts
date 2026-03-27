/**
 * Detects and stops orphaned Nexus Docker containers from other workspaces/sessions.
 *
 * Orphaned stacks accumulate when `koi up` is run from multiple worktrees
 * or directories without stopping previous sessions. Each stack consumes
 * ~1GB of RAM, and 4+ orphans can trigger OOM kills that leave the terminal
 * in a broken state (raw mode + mouse tracking — see #1076).
 *
 * Used by:
 * - `koi up` — warns before Nexus startup, blocks if memory is constrained
 * - `koi stop --nexus-all` — stops all Nexus containers across workspaces
 */

import { spawnSync } from "node:child_process";
import { freemem } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NexusProjectInfo {
  readonly projectName: string;
  readonly containers: readonly string[];
}

// ---------------------------------------------------------------------------
// Shared: list running Nexus Docker projects
// ---------------------------------------------------------------------------

/**
 * Lists all running Nexus Docker Compose projects, grouped by project name.
 *
 * Returns an empty array if Docker is unavailable or no Nexus containers are running.
 */
function listNexusProjects(): readonly NexusProjectInfo[] {
  const result = spawnSync(
    "docker",
    ["ps", "--filter", "name=nexus-", "--format", "{{.Names}}\t{{.Status}}"],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 5000 },
  );

  if (result.status !== 0 || result.stdout === null) return [];

  const output = result.stdout.toString().trim();
  if (output === "") return [];

  // Group containers by project name prefix (e.g., "nexus-abcd1234-postgres-1"
  // and "nexus-abcd1234-api-1" both belong to project "nexus-abcd1234")
  const projects = new Map<string, string[]>();

  for (const line of output.split("\n")) {
    const [name] = line.split("\t");
    if (name === undefined || name === "") continue;

    // Extract project name: "nexus-{hash}-{service}-{replica}" → "nexus-{hash}"
    const match = /^(nexus-[a-f0-9]+)/.exec(name);
    if (match === null) continue;

    const projectName = match[1];
    if (projectName === undefined) continue;
    const existing = projects.get(projectName);
    if (existing !== undefined) {
      existing.push(name);
    } else {
      projects.set(projectName, [name]);
    }
  }

  return [...projects.entries()].map(([projectName, containers]) => ({
    projectName,
    containers,
  }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Minimum free memory (in bytes) required to start a Nexus stack. */
const MIN_FREE_MEMORY_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

/**
 * Detects running Nexus Docker containers that don't belong to the current
 * workspace and warns the user if any are found.
 *
 * If system free memory is below 2GB and orphaned stacks exist, returns `false`
 * to signal that startup should be blocked.
 *
 * Non-fatal: silently returns `true` (proceed) if Docker is unavailable.
 *
 * @param currentProjectName - The Nexus project name for the current workspace
 *   (e.g., "nexus-abcd1234" from `.state.json`). Containers matching this
 *   project are excluded from the orphan list. Pass `undefined` if unknown.
 * @returns `true` if startup should proceed, `false` if blocked due to memory pressure.
 */
export function detectOrphanedNexusStacks(currentProjectName: string | undefined): boolean {
  try {
    const allProjects = listNexusProjects();
    const orphaned = allProjects.filter((p) => p.projectName !== currentProjectName);

    if (orphaned.length === 0) return true;

    const totalContainers = orphaned.reduce((sum, p) => sum + p.containers.length, 0);
    const stackWord = orphaned.length === 1 ? "stack" : "stacks";
    const containerWord = totalContainers === 1 ? "container" : "containers";

    // Check system memory
    const freeBytes = freemem();
    const freeGb = freeBytes / (1024 * 1024 * 1024);
    const memoryConstrained = freeBytes < MIN_FREE_MEMORY_BYTES;

    if (memoryConstrained) {
      process.stderr.write(
        `\nError: ${String(orphaned.length)} orphaned Nexus ${stackWord} detected ` +
          `(${String(totalContainers)} ${containerWord}, ~${String(orphaned.length)}GB RAM) ` +
          `and only ${freeGb.toFixed(1)}GB free memory available.\n` +
          `Starting another Nexus stack risks OOM kills that corrupt your terminal.\n` +
          `Clean up first: koi stop --nexus-all\n\n`,
      );
      return false;
    }

    process.stderr.write(
      `\nWarning: ${String(orphaned.length)} orphaned Nexus ${stackWord} detected ` +
        `(${String(totalContainers)} ${containerWord}, ~${String(orphaned.length)}GB RAM).\n` +
        `These are from other workspaces/sessions and may cause memory pressure.\n` +
        `Clean up with: koi stop --nexus-all\n\n`,
    );
    return true;
  } catch {
    // Docker not available or unexpected error — non-fatal, allow startup
    return true;
  }
}

/**
 * Stops ALL running Nexus Docker containers across all workspaces/sessions.
 *
 * Used by `koi stop --nexus-all`. Finds every container whose name matches
 * `nexus-*` and stops it via `docker stop`.
 *
 * @returns The number of containers stopped, or -1 if Docker is unavailable.
 */
export function stopAllNexusStacks(): number {
  try {
    const allProjects = listNexusProjects();
    if (allProjects.length === 0) {
      process.stderr.write("No running Nexus containers found.\n");
      return 0;
    }

    const allContainers = allProjects.flatMap((p) => p.containers);
    process.stderr.write(
      `Stopping ${String(allContainers.length)} Nexus containers ` +
        `across ${String(allProjects.length)} stacks...\n`,
    );

    const result = spawnSync("docker", ["stop", ...allContainers], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });

    if (result.status !== 0) {
      const stderr = result.stderr?.toString().trim() ?? "";
      const detail = stderr !== "" ? `: ${stderr}` : "";
      process.stderr.write(
        `Warning: docker stop exited with code ${String(result.status)}${detail}\n`,
      );
      return -1;
    }

    process.stderr.write(`Stopped ${String(allContainers.length)} Nexus containers.\n`);
    return allContainers.length;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Failed to stop Nexus containers: ${message}\n`);
    return -1;
  }
}
