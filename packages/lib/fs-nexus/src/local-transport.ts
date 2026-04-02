/**
 * Local subprocess transport — spawns a Python bridge process that
 * wraps SlimNexusFS with stdin/stdout JSON-RPC.
 *
 * No HTTP server, no port, no network. Just IPC at ~1-2ms per call.
 *
 * Usage:
 *   const transport = await createLocalTransport({ mountUri: "local://./workspace" });
 *   // transport implements NexusTransport — plug into createNexusFileSystem
 */

import type { KoiError, Result } from "@koi/core";
import { mapNexusError } from "./errors.js";
import type { JsonRpcResponse, NexusTransport } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface LocalTransportConfig {
  /**
   * Nexus mount URI(s). Supports any URI that nexus-fs accepts:
   *   - "local://./workspace"
   *   - "s3://my-bucket/agents"
   *   - "gcs://my-bucket/agents"
   *
   * Pass an array to mount multiple sources simultaneously.
   */
  readonly mountUri: string | readonly string[];
  /** Path to Python 3 executable. Default: "python3". */
  readonly pythonPath?: string | undefined;
  /** Max time to wait for the bridge process to start (ms). Default: 10_000. */
  readonly startupTimeoutMs?: number | undefined;
  /**
   * Environment variables forwarded to the bridge subprocess.
   * Use for credentials that nexus-fs needs:
   *   - AWS: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_PROFILE
   *   - GCS: GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_CLOUD_PROJECT
   *   - OAuth: NEXUS_AUTH_TOKEN
   *
   * These are merged with (and override) the parent process env.
   * Never logged or included in error messages.
   */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** Per-RPC call timeout (ms). Default: 30_000. Kills bridge on expiry. */
  readonly callTimeoutMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_PYTHON = "python3";
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/**
 * Resolve bridge.py path — works from both src/ (dev) and dist/ (built).
 * The bridge lives at the package root's src/bridge.py.
 */
const BRIDGE_PATH = new URL("../src/bridge.py", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Line reader — persistent reader over a ReadableStream
// ---------------------------------------------------------------------------

/** Reads newline-delimited lines from a ReadableStream, preserving state across calls. */
function createLineReader(stream: ReadableStream<Uint8Array>): {
  readonly nextLine: () => Promise<string>;
  readonly release: () => void;
} {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function nextLine(): Promise<string> {
    while (true) {
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        return line;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("Stream ended before newline");
      buffer += decoder.decode(value, { stream: true });
    }
  }

  function release(): void {
    reader.releaseLock();
  }

  return { nextLine, release };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Spawn a local nexus-fs bridge process and return a NexusTransport.
 *
 * The bridge imports SlimNexusFS, mounts the given URI, and speaks
 * JSON-RPC 2.0 over stdin/stdout. No HTTP server needed.
 *
 * Call `transport.close()` to kill the subprocess.
 */
export async function createLocalTransport(config: LocalTransportConfig): Promise<NexusTransport> {
  const pythonPath = config.pythonPath ?? DEFAULT_PYTHON;
  const startupTimeout = config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const callTimeout = config.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const mountUris = typeof config.mountUri === "string" ? [config.mountUri] : config.mountUri;

  const spawnEnv = config.env !== undefined ? { ...process.env, ...config.env } : process.env;

  const proc = Bun.spawn([pythonPath, BRIDGE_PATH, ...mountUris], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: spawnEnv,
  });

  const lineReader = createLineReader(proc.stdout);

  // Wait for the "ready" signal from the bridge
  const readyLine = await Promise.race([
    lineReader.nextLine(),
    rejectAfter(startupTimeout, "Bridge process did not start within timeout"),
    procExit(proc),
  ]);

  let mounts: readonly string[] = [];
  try {
    const ready = JSON.parse(readyLine) as {
      readonly ready?: boolean;
      readonly mounts?: readonly string[];
    };
    if (ready.ready !== true) {
      throw new Error(`Unexpected bridge startup message: ${readyLine}`);
    }
    mounts = ready.mounts ?? [];
  } catch (e: unknown) {
    lineReader.release();
    proc.kill();
    const stderr = await collectStderr(proc);
    throw new Error(
      `Failed to start nexus-fs bridge: ${e instanceof Error ? e.message : String(e)}${stderr ? `\nstderr: ${stderr}` : ""}`,
    );
  }

  let nextId = 1;
  let closed = false;
  // Mutex: serialize all calls through the stdin/stdout pipe.
  // Without this, concurrent calls could read each other's responses.
  let pending: Promise<unknown> = Promise.resolve();

  async function call<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Result<T, KoiError>> {
    if (closed) {
      return {
        ok: false,
        error: { code: "INTERNAL", message: "Transport closed", retryable: false },
      };
    }

    // Chain onto the pending promise so only one request is in-flight at a time
    const result = pending.then(async (): Promise<Result<T, KoiError>> => {
      const requestId = nextId++;
      const request = JSON.stringify({
        jsonrpc: "2.0",
        method,
        params,
        id: requestId,
      });

      try {
        // Write request to stdin
        proc.stdin.write(`${request}\n`);
        await proc.stdin.flush();

        // Read response from stdout with per-call timeout.
        // If the bridge stalls, we timeout and kill the process
        // so queued operations fail fast instead of wedging.
        const line = await Promise.race([
          lineReader.nextLine(),
          rejectAfter(
            callTimeout,
            `Bridge call "${method}" timed out after ${String(callTimeout)}ms`,
          ),
        ]);
        const response = JSON.parse(line) as JsonRpcResponse<T>;

        // Verify response matches our request
        if (response.id !== requestId) {
          return {
            ok: false,
            error: {
              code: "INTERNAL",
              message: `Response id mismatch: expected ${String(requestId)}, got ${String(response.id)}`,
              retryable: false,
            },
          };
        }

        if (response.error !== undefined) {
          return { ok: false, error: mapNexusError(response.error, method) };
        }

        return { ok: true, value: response.result as T };
      } catch (e: unknown) {
        if (closed) {
          return {
            ok: false,
            error: { code: "INTERNAL", message: "Transport closed", retryable: false },
          };
        }
        // On timeout, kill the bridge so queued calls fail fast
        const isTimeout = e instanceof Error && e.message.includes("timed out");
        if (isTimeout) {
          close();
        }
        return { ok: false, error: mapNexusError(e, method) };
      }
    });

    // Update the chain — swallow errors so the chain never rejects
    pending = result.catch(() => {});

    return result;
  }

  function close(): void {
    if (closed) return;
    closed = true;
    lineReader.release();
    try {
      proc.stdin.end();
      proc.kill();
    } catch {
      // Process may already be dead
    }
  }

  return { call, close, mounts };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reject after ms milliseconds. */
function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

/** Reject if process exits before we get what we need. */
async function procExit(proc: { readonly exited: Promise<number> }): Promise<never> {
  const code = await proc.exited;
  throw new Error(`Bridge process exited with code ${String(code)}`);
}

/** Collect stderr output for error messages. */
async function collectStderr(proc: {
  readonly stderr: ReadableStream<Uint8Array>;
}): Promise<string> {
  try {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    let output = "";
    const { value, done } = await reader.read();
    if (!done && value !== undefined) {
      output = decoder.decode(value);
    }
    reader.releaseLock();
    return output.trim();
  } catch {
    return "";
  }
}
