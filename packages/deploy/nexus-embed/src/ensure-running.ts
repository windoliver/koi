/**
 * Main entry point for Nexus embed mode.
 *
 * Ensures a Nexus server is running locally:
 * 1. Check saved connection state -> probe health -> reuse if alive
 * 2. Clean stale PID if dead
 * 3. Resolve binary (uv run nexus / NEXUS_COMMAND)
 * 4. Spawn detached daemon
 * 5. Poll health until ready
 * 6. Save connection state + PID
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { KoiError, Result } from "@koi/core";
import { checkBinaryAvailable, resolveNexusBinary } from "./binary-resolver.js";
import {
  readConnectionState,
  removeConnectionState,
  writeConnectionState,
} from "./connection-store.js";
import { DEFAULT_DATA_DIR_NAME, DEFAULT_HOST, DEFAULT_PORT, DEFAULT_PROFILE } from "./constants.js";
import { pollHealth, probeHealth } from "./health-check.js";
import { cleanStalePid, isProcessAlive, readPid, removePid, writePid } from "./pid-manager.js";
import type { ConnectionState, EmbedConfig, EmbedResult } from "./types.js";

/**
 * Derive a per-workspace data directory to isolate parallel worktrees.
 *
 * Hashes the absolute `cwd` path (MD5, first 8 hex chars) to produce a
 * stable subdirectory under `~/.koi/nexus/`. This mirrors the Nexus CLI's
 * own project isolation pattern (`nexus-{md5(data_dir)[:8]}`).
 */
export function deriveDataDir(cwd: string): string {
  const absPath = resolve(cwd);
  const hash = createHash("md5").update(absPath).digest("hex").slice(0, 8);
  return join(homedir(), DEFAULT_DATA_DIR_NAME, hash);
}

/** Ensure a Nexus server is running locally, spawning one if needed. */
export async function ensureNexusRunning(
  config?: EmbedConfig | undefined,
): Promise<Result<EmbedResult, KoiError>> {
  const port = config?.port ?? DEFAULT_PORT;
  const host = config?.host ?? DEFAULT_HOST;
  const profile = config?.profile ?? process.env.NEXUS_EMBED_PROFILE ?? DEFAULT_PROFILE;
  const cwd = config?.cwd ?? process.cwd();
  const dataDir = config?.dataDir ?? deriveDataDir(cwd);
  const fetchFn = config?.fetch;
  const spawnFn = config?.spawn;

  const baseUrl = `http://${host}:${String(port)}`;

  // 1. Check saved state — reuse if alive AND config matches
  const savedState = readConnectionState(dataDir);
  if (savedState !== undefined) {
    const configMatches =
      savedState.port === port && savedState.host === host && savedState.profile === profile;

    if (configMatches) {
      const savedUrl = `http://${savedState.host}:${String(savedState.port)}`;
      const alive = await probeHealth(savedUrl, fetchFn);
      if (alive) {
        return {
          ok: true,
          value: { baseUrl: savedUrl, spawned: false, pid: savedState.pid },
        };
      }
    }

    // Config mismatch with a still-alive process — stop it before spawning new one
    if (!configMatches && savedState.pid !== undefined && isProcessAlive(savedState.pid)) {
      try {
        process.kill(savedState.pid, "SIGTERM");
      } catch {
        /* best effort */
      }
    }

    // Dead or config mismatch — clean up stale state
    cleanStalePid(dataDir);
    removePid(dataDir);
    removeConnectionState(dataDir);
  }

  // 2. Also check if something is already running on the port (not from us)
  const alreadyRunning = await probeHealth(baseUrl, fetchFn);
  if (alreadyRunning) {
    const pid = readPid(dataDir);
    return {
      ok: true,
      value: { baseUrl, spawned: false, pid: pid ?? undefined },
    };
  }

  // 3. Resolve binary
  const binaryParts = resolveNexusBinary(config?.sourceDir);
  const available = await checkBinaryAvailable(binaryParts);
  if (!available) {
    const binaryName = binaryParts[0] ?? "nexus";
    return {
      ok: false,
      error: {
        code: "NOT_FOUND" as const,
        message: `Cannot find '${binaryName}' on PATH. Install it:\n  - uv: pip install nexus-ai-fs\n  - Or set NEXUS_COMMAND (space-separated, no quoting)`,
        retryable: false,
        context: { binary: binaryName, binaryParts: [...binaryParts] },
      },
    };
  }

  // 4. Build spawn command
  const cmd = [
    ...binaryParts,
    "serve",
    "--host",
    host,
    "--port",
    String(port),
    "--profile",
    profile,
  ];

  // 5. Spawn detached daemon
  let pid: number | undefined;
  try {
    const doSpawn =
      spawnFn ??
      ((
        c: readonly string[],
        opts?: Record<string, unknown>,
      ): { readonly pid: number | undefined; readonly unref: () => void } => {
        const proc = Bun.spawn(c as string[], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          ...opts,
        });
        proc.unref();
        return { pid: proc.pid, unref: () => proc.unref() };
      });

    const spawned = doSpawn(cmd, {
      env: { ...process.env },
    });
    pid = spawned.pid;
    spawned.unref();
  } catch (err: unknown) {
    return {
      ok: false,
      error: {
        code: "EXTERNAL" as const,
        message: `Failed to spawn Nexus: ${err instanceof Error ? err.message : String(err)}`,
        retryable: false,
        cause: err,
        context: { cmd },
      },
    };
  }

  if (pid === undefined) {
    return {
      ok: false,
      error: {
        code: "EXTERNAL" as const,
        message: "Nexus process spawned but PID is undefined",
        retryable: false,
      },
    };
  }

  // 6. Write PID immediately
  writePid(dataDir, pid);

  // 7. Poll health until ready
  const healthResult = await pollHealth(baseUrl, fetchFn);
  if (!healthResult.ok) {
    // Cleanup on failure — kill process and remove PID file
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* best effort */
    }
    removePid(dataDir);
    return healthResult;
  }

  // 8. Save full connection state
  const state: ConnectionState = {
    port,
    pid,
    host,
    profile,
    startedAt: new Date().toISOString(),
  };
  writeConnectionState(dataDir, state);

  return {
    ok: true,
    value: { baseUrl, spawned: true, pid },
  };
}
