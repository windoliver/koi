/**
 * Detects and stops orphaned Nexus Docker containers from Koi workspaces.
 *
 * Orphaned stacks accumulate when `koi up` is run from multiple worktrees
 * or directories without stopping previous sessions. Each stack consumes
 * ~1GB of RAM, and 4+ orphans can trigger OOM kills that leave the terminal
 * in a broken state (raw mode + mouse tracking — see #1076).
 *
 * Only flags containers that belong to known Koi Nexus projects (verified
 * via ~/.koi/nexus/{hash}/ state directories). Unrelated Docker containers
 * that happen to start with "nexus-" are never touched.
 *
 * Used by:
 * - `koi up` — warns before Nexus startup, blocks if memory is constrained
 * - `koi stop --nexus-all` — stops all Koi Nexus containers across workspaces
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { freemem, homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NexusProjectInfo {
  readonly projectName: string;
  readonly containers: readonly string[];
}

// ---------------------------------------------------------------------------
// Koi project discovery
// ---------------------------------------------------------------------------

/**
 * Returns the set of Nexus project names that Koi has managed.
 *
 * Scans `~/.koi/nexus/` for workspace directories. Each subdirectory
 * name is the 8-hex hash used in the Docker Compose project name
 * (e.g., directory "abcd1234" → project "nexus-abcd1234").
 */
function listKoiNexusProjectNames(): ReadonlySet<string> {
  try {
    const nexusDir = join(homedir(), ".koi", "nexus");
    if (!existsSync(nexusDir)) return new Set();

    const entries = readdirSync(nexusDir, { withFileTypes: true });
    const names = new Set<string>();
    for (const entry of entries) {
      // Only include directories whose name is exactly 8 hex chars
      if (entry.isDirectory() && /^[a-f0-9]{8}$/.test(entry.name)) {
        names.add(`nexus-${entry.name}`);
      }
    }
    return names;
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Docker container listing
// ---------------------------------------------------------------------------

/**
 * Lists running Koi-managed Nexus Docker Compose projects.
 *
 * Filters in two stages:
 * 1. Docker filter: containers whose name starts with "nexus-"
 * 2. Regex: only names matching Koi's convention (nexus-{8hex}-{service}-{n})
 * 3. Cross-reference: only projects with a matching ~/.koi/nexus/{hash}/ dir
 *
 * Returns an empty array if Docker is unavailable or no Koi containers are running.
 */
function listKoiNexusContainers(): readonly NexusProjectInfo[] {
  const result = spawnSync(
    "docker",
    ["ps", "-a", "--filter", "name=nexus-", "--format", "{{.Names}}"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    },
  );

  if (result.status !== 0 || result.stdout === null) return [];

  const output = result.stdout.toString().trim();
  if (output === "") return [];

  // Known Koi project names from ~/.koi/nexus/ state directories
  const koiProjects = listKoiNexusProjectNames();

  // Group containers by project, only keeping Koi-managed ones
  const projects = new Map<string, string[]>();

  for (const name of output.split("\n")) {
    if (name === "") continue;

    // Match Koi's naming convention: "nexus-{exactly 8 hex}-..."
    const match = /^(nexus-[a-f0-9]{8})(?:-|$)/.exec(name);
    if (match === null) continue;

    const projectName = match[1];
    if (projectName === undefined) continue;

    // Only include containers that belong to a known Koi workspace
    if (!koiProjects.has(projectName)) continue;

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
 * Detects running Koi Nexus containers that don't belong to the current
 * workspace and warns the user if any are found.
 *
 * Only flags containers verified to belong to Koi (cross-referenced against
 * `~/.koi/nexus/` state directories). Non-Koi containers are ignored.
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
    const allProjects = listKoiNexusContainers();
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
        `\nError: ${String(orphaned.length)} orphaned Koi Nexus ${stackWord} detected ` +
          `(${String(totalContainers)} ${containerWord}, ~${String(orphaned.length)}GB RAM) ` +
          `and only ${freeGb.toFixed(1)}GB free memory available.\n` +
          `Starting another Nexus stack risks OOM kills that corrupt your terminal.\n` +
          `Clean up first: koi stop --nexus-all\n\n`,
      );
      return false;
    }

    process.stderr.write(
      `\nWarning: ${String(orphaned.length)} orphaned Koi Nexus ${stackWord} detected ` +
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
 * Stops ALL running Koi-managed Nexus Docker containers across all workspaces.
 *
 * Used by `koi stop --nexus-all`. Only stops containers verified to belong to
 * Koi (cross-referenced against `~/.koi/nexus/` state directories).
 *
 * @returns The number of containers stopped, or -1 if Docker is unavailable.
 */
export function stopAllNexusStacks(): number {
  try {
    const allProjects = listKoiNexusContainers();
    if (allProjects.length === 0) {
      process.stderr.write("No running Koi Nexus containers found.\n");
      return 0;
    }

    const allContainers = allProjects.flatMap((p) => p.containers);
    process.stderr.write(
      `Stopping ${String(allContainers.length)} Koi Nexus containers ` +
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

    process.stderr.write(`Stopped ${String(allContainers.length)} Koi Nexus containers.\n`);
    return allContainers.length;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Failed to stop Koi Nexus containers: ${message}\n`);
    return -1;
  }
}
