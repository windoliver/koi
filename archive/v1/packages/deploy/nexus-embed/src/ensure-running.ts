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
import { existsSync, readFileSync } from "node:fs";
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

/** Read the API key from multiple sources:
 *  1. Local .state.json  2. Shared key file  3. Scan all data dirs */
function readApiKeyFromState(dataDir: string, port?: number): string | undefined {
  // 1. Local state
  const localKey = readApiKeyFromStateFile(join(dataDir, ".state.json"));
  if (localKey !== undefined) return localKey;

  // 2. Shared key (written by whichever session started Nexus via nexusUp)
  const sharedKey = readSharedNexusKey();
  if (sharedKey !== undefined) return sharedKey;

  // 3. Scan all data dirs for a matching port
  if (port !== undefined) {
    try {
      const nexusDir = join(homedir(), ".koi", "nexus");
      if (!existsSync(nexusDir)) return undefined;
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      for (const entry of readdirSync(nexusDir)) {
        const statePath = join(nexusDir, entry, ".state.json");
        const key = readApiKeyFromStateFile(statePath);
        if (key !== undefined) {
          // Verify the port matches
          try {
            const raw = readFileSync(statePath, "utf-8");
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            const ports = parsed.ports as Record<string, unknown> | undefined;
            if (ports !== undefined && ports.http === port) return key;
          } catch {
            /* */
          }
        }
      }
    } catch {
      /* */
    }
  }

  return undefined;
}

function readApiKeyFromStateFile(statePath: string): string | undefined {
  try {
    if (!existsSync(statePath)) return undefined;
    const raw = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.api_key === "string" ? parsed.api_key : undefined;
  } catch {
    return undefined;
  }
}

const NEXUS_SHARED_KEY_FILE = ".current-key";

/** Write the API key to a shared location so other worktrees can discover it. */
export function writeSharedNexusKey(apiKey: string): void {
  try {
    const nexusDir = join(homedir(), ".koi", "nexus");
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(nexusDir, { recursive: true });
    writeFileSync(join(nexusDir, NEXUS_SHARED_KEY_FILE), apiKey, "utf-8");
  } catch {
    /* best effort */
  }
}

/** Read the shared API key written by any worktree that started Nexus. */
export function readSharedNexusKey(): string | undefined {
  try {
    const keyPath = join(homedir(), ".koi", "nexus", NEXUS_SHARED_KEY_FILE);
    if (!existsSync(keyPath)) return undefined;
    const content = readFileSync(keyPath, "utf-8").trim();
    return content.length > 0 ? content : undefined;
  } catch {
    return undefined;
  }
}

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
          value: {
            baseUrl: savedUrl,
            spawned: false,
            pid: savedState.pid,
            apiKey: readApiKeyFromState(dataDir, port),
          },
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
      value: {
        baseUrl,
        spawned: false,
        pid: pid ?? undefined,
        apiKey: readApiKeyFromState(dataDir, port),
      },
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
    value: { baseUrl, spawned: true, pid, apiKey: readApiKeyFromState(dataDir, port) },
  };
}
