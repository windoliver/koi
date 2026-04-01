/**
 * Check whether a brick's runtime requirements are satisfiable.
 *
 * Checks brick.requires.tools and brick.requires.agents against a local
 * ForgeStore, falling back to a remote BrickRegistryReader when provided.
 * Reports bins and env vars as unsatisfied if missing from the local env.
 */

import type { BrickArtifact, BrickRegistryReader, ForgeStore } from "@koi/core";
import type { DependencyCheckResult, MissingDependency } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether all of a brick's declared requirements can be satisfied.
 *
 * - `tools` and `agents` are checked against the local store first.
 *   If missing locally and a remote registry is provided, the remote is checked.
 * - `bins` are checked via Bun.which (or which-equivalent).
 * - `env` vars are checked against process.env.
 *
 * Returns { satisfied: true } when all deps are met, otherwise returns
 * the list of missing dependencies with their remote availability status.
 */
export async function checkBrickDependencies(
  brick: BrickArtifact,
  localStore: ForgeStore,
  remoteRegistry?: BrickRegistryReader,
): Promise<DependencyCheckResult> {
  const requires = brick.requires;

  // No requirements means everything is satisfied
  if (requires === undefined) {
    return { satisfied: true };
  }

  const missing: MissingDependency[] = [];

  // Check required tools
  if (requires.tools !== undefined && requires.tools.length > 0) {
    const toolResults = await checkBrickRefs(requires.tools, "tool", localStore, remoteRegistry);
    for (const result of toolResults) {
      missing.push(result);
    }
  }

  // Check required agents
  if (requires.agents !== undefined && requires.agents.length > 0) {
    const agentResults = await checkBrickRefs(requires.agents, "agent", localStore, remoteRegistry);
    for (const result of agentResults) {
      missing.push(result);
    }
  }

  // Check required binaries
  if (requires.bins !== undefined && requires.bins.length > 0) {
    for (const bin of requires.bins) {
      if (!isBinAvailable(bin)) {
        missing.push({ kind: "bin", name: bin, availableRemotely: false });
      }
    }
  }

  // Check required environment variables
  if (requires.env !== undefined && requires.env.length > 0) {
    for (const envVar of requires.env) {
      if (!isEnvSet(envVar)) {
        missing.push({ kind: "env", name: envVar, availableRemotely: false });
      }
    }
  }

  if (missing.length === 0) {
    return { satisfied: true };
  }

  return { satisfied: false, missing };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check a list of brick names against local store and optional remote registry.
 * Returns only the missing dependencies.
 */
async function checkBrickRefs(
  names: readonly string[],
  brickKind: "tool" | "agent",
  localStore: ForgeStore,
  remoteRegistry?: BrickRegistryReader,
): Promise<readonly MissingDependency[]> {
  const missing: MissingDependency[] = [];

  for (const name of names) {
    // Check local store first
    const localResult = await localStore.search({
      kind: brickKind,
      text: name,
      limit: 1,
    });

    const foundLocally =
      localResult.ok &&
      localResult.value.length > 0 &&
      localResult.value.some((b) => b.name === name);

    if (foundLocally) continue;

    // Check remote registry if provided
    let availableRemotely = false;
    if (remoteRegistry !== undefined) {
      try {
        const remoteResult = await remoteRegistry.get(brickKind, name);
        availableRemotely = remoteResult.ok;
      } catch {
        // Remote check failed — treat as unavailable
        availableRemotely = false;
      }
    }

    missing.push({ kind: brickKind, name, availableRemotely });
  }

  return missing;
}

/** Check if a binary is available on PATH. */
function isBinAvailable(name: string): boolean {
  // Use Bun.which for binary lookup when available
  if (typeof Bun !== "undefined" && typeof Bun.which === "function") {
    return Bun.which(name) !== null;
  }
  // Fallback: cannot determine, report as unavailable
  return false;
}

/** Check if an environment variable is set. */
function isEnvSet(name: string): boolean {
  return process.env[name] !== undefined && process.env[name] !== "";
}
