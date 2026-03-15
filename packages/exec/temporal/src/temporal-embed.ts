/**
 * Temporal embed mode — auto-start `temporal server start-dev` locally.
 *
 * Decision 15A: Lazy start + docs. Same pattern as Nexus embed mode (#898).
 * Only starts if manifest.temporal is configured and no external URL given.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TemporalEmbedConfig {
  /** gRPC port for the Temporal server. Default: 7233. */
  readonly port: number;
  /** HTTP port for the Temporal Web UI. Default: 8233. */
  readonly uiPort: number;
  /** SQLite DB path for persistent storage. Undefined = in-memory. */
  readonly dbPath: string | undefined;
  /** Max wait time for server to become ready (ms). Default: 15_000. */
  readonly startupTimeoutMs: number;
  /** Poll interval when waiting for server readiness (ms). Default: 500. */
  readonly pollIntervalMs: number;
}

export const DEFAULT_EMBED_CONFIG: TemporalEmbedConfig = Object.freeze({
  port: 7233,
  uiPort: 8233,
  dbPath: undefined,
  startupTimeoutMs: 30_000,
  pollIntervalMs: 500,
});

export interface TemporalEmbedHandle {
  /** The gRPC URL for connecting clients/workers. */
  readonly url: string;
  /** The HTTP URL for the Temporal Web UI. */
  readonly uiUrl: string;
  /** Stop the embedded server and clean up the PID file. */
  readonly dispose: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// PID file management
// ---------------------------------------------------------------------------

function pidFilePath(): string {
  const koiDir = join(homedir(), ".koi");
  if (!existsSync(koiDir)) {
    mkdirSync(koiDir, { recursive: true });
  }
  return join(koiDir, "temporal-embed.pid");
}

function readPidFile(): number | undefined {
  const path = pidFilePath();
  if (!existsSync(path)) return undefined;
  try {
    const content = readFileSync(path, "utf-8").trim();
    const pid = Number.parseInt(content, 10);
    return Number.isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

function writePidFile(pid: number): void {
  writeFileSync(pidFilePath(), String(pid), "utf-8");
}

function removePidFile(): void {
  try {
    unlinkSync(pidFilePath());
  } catch {
    // Already removed — no-op
  }
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/**
 * Check if Temporal server is ready by probing its gRPC port with a TCP connect.
 * The HTTP health endpoint is not available in headless mode, and the API
 * layout changed across Temporal CLI versions. A TCP connect to the gRPC
 * port is the most reliable cross-version readiness signal.
 */
async function isServerReady(port: number, _timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const { connect } = require("node:net") as typeof import("node:net");
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(2_000);
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

async function findTemporalBinary(): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["which", "temporal"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return exitCode === 0 ? text.trim() : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Process management
// ---------------------------------------------------------------------------

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Ensure a Temporal dev server is running locally.
 *
 * 1. Check if already running on the configured port (via PID file + health check)
 * 2. Find the `temporal` CLI binary
 * 3. Spawn `temporal server start-dev`
 * 4. Poll until ready (max startupTimeoutMs)
 * 5. Write PID file for tracking
 *
 * @param config - Embed configuration (merged with defaults)
 * @returns Handle with URL and dispose function
 * @throws Error if binary not found or server fails to start
 */
export async function ensureTemporalRunning(
  config: Partial<TemporalEmbedConfig> = {},
): Promise<TemporalEmbedHandle> {
  const resolved: TemporalEmbedConfig = { ...DEFAULT_EMBED_CONFIG, ...config };
  const url = `localhost:${resolved.port}`;
  const uiUrl = `http://localhost:${resolved.uiPort}`;

  // 1. Check if already running
  const existingPid = readPidFile();
  if (existingPid !== undefined && isProcessRunning(existingPid)) {
    const ready = await isServerReady(resolved.port, 2_000);
    if (ready) {
      return {
        url,
        uiUrl,
        async dispose() {
          try {
            process.kill(existingPid, "SIGTERM");
          } catch {
            // Already dead
          }
          removePidFile();
        },
      };
    }
  }

  // 2. Find binary
  const binary = await findTemporalBinary();
  if (binary === undefined) {
    throw new Error(
      "Temporal CLI binary not found. Install it with: brew install temporal\n" +
        "Or download from: https://temporal.io/setup/start-development-server\n" +
        "Alternatively, set temporal.url in koi.yaml to connect to an external server.",
    );
  }

  // 3. Build command
  const baseArgs = [
    "server",
    "start-dev",
    "--port",
    String(resolved.port),
    "--ui-port",
    String(resolved.uiPort),
    "--headless",
  ] as const;

  const args =
    resolved.dbPath !== undefined ? [...baseArgs, "--db-filename", resolved.dbPath] : [...baseArgs];

  // 4. Spawn
  const child = Bun.spawn([binary, ...args], {
    stdout: "ignore",
    stderr: "ignore",
  });

  const pid = child.pid;
  writePidFile(pid);

  // 5. Poll until ready
  const deadline = Date.now() + resolved.startupTimeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await isServerReady(resolved.port, 2_000);
    if (ready) break;
    await new Promise((r) => setTimeout(r, resolved.pollIntervalMs));
  }

  if (!ready) {
    // Clean up
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already dead
    }
    removePidFile();
    throw new Error(
      `Temporal dev server failed to start within ${resolved.startupTimeoutMs}ms on port ${resolved.port}`,
    );
  }

  return {
    url,
    uiUrl,
    async dispose() {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already dead
      }
      removePidFile();
    },
  };
}
