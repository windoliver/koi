/**
 * Local subprocess transport — spawns a Python bridge process that
 * wraps SlimNexusFS with stdin/stdout JSON-RPC.
 *
 * No HTTP server, no port, no network. Just IPC at ~1-2ms per call.
 *
 * Usage:
 *   const transport = await createLocalTransport({ mountUri: "local://./workspace" });
 *   // transport implements NexusTransport — plug into createNexusFileSystem
 *
 * Auth notifications:
 *   transport.subscribe(n => {
 *     if (n.method === "auth_required") showLink(n.params.auth_url);
 *   });
 */

import type { KoiError, Result } from "@koi/core";
import { mapNexusError } from "./errors.js";
import type { BridgeNotification, JsonRpcResponse, NexusTransport } from "./types.js";

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
  /**
   * Max time to wait for the user to complete an OAuth flow (ms). Default: 300_000 (5 min).
   * When auth_required is received, the pending call's timeout is extended to this value
   * so the user has time to authorize in their browser.
   * Forwarded to bridge as NEXUS_AUTH_TIMEOUT_MS env variable.
   */
  readonly authTimeoutMs?: number | undefined;
  /**
   * @internal Test-only override for the bridge script path.
   * Allows unit tests to inject a mock bridge without nexus-fs installed.
   * Never set this in production code.
   */
  readonly _bridgePath?: string | undefined;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_PYTHON = "python3";
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_AUTH_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Resolve bridge.py path — works from both src/ (dev) and dist/ (built).
 * In dev: import.meta.url is src/local-transport.ts → sibling bridge.py
 * In built: import.meta.url is dist/index.js → sibling bridge.py (copied by tsup onSuccess)
 */
const BRIDGE_PATH = new URL("./bridge.py", import.meta.url).pathname;

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
// Pending request entry
// ---------------------------------------------------------------------------

interface PendingRequest {
  readonly resolve: (line: string) => void;
  readonly reject: (e: Error) => void;
  // Timer handle so we can clear it when auth_required extends the deadline
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Notification type guard — spec-correct per JSON-RPC 2.0.
// id: null is a valid *response* (parse error); only absent `id` is a notification.
// ---------------------------------------------------------------------------

function isNotification(msg: unknown): msg is BridgeNotification {
  return (
    typeof msg === "object" && msg !== null && !("id" in msg) && "method" in msg && "jsonrpc" in msg
  );
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
 * Call `transport.close()` to kill the subprocess and reject all pending calls.
 * Subscribe to `transport.subscribe()` to receive auth_required / auth_complete
 * / auth_progress notifications during inline OAuth flows.
 */
export async function createLocalTransport(config: LocalTransportConfig): Promise<NexusTransport> {
  const pythonPath = config.pythonPath ?? DEFAULT_PYTHON;
  const startupTimeout = config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const callTimeout = config.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const authTimeout = config.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const mountUris = typeof config.mountUri === "string" ? [config.mountUri] : config.mountUri;

  const spawnEnv: Record<string, string> = {
    ...(config.env !== undefined ? { ...process.env, ...config.env } : process.env),
    NEXUS_AUTH_TIMEOUT_MS: String(authTimeout),
  };

  const bridgePath = config._bridgePath ?? BRIDGE_PATH;

  const proc = Bun.spawn([pythonPath, bridgePath, ...mountUris], {
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

  // Pending request map — each in-flight call parks here until its response arrives.
  const pendingRequests = new Map<number, PendingRequest>();

  // Notification handlers — fire-and-forget microtask dispatch (Issue 15-A).
  const notificationHandlers = new Set<(n: BridgeNotification) => void>();

  // ---------------------------------------------------------------------------
  // Background reader loop (Issue 1-A)
  // Routes every stdout line: responses → pending request callbacks,
  // notifications → subscribed handlers. Replaces the old mutex chain.
  // ---------------------------------------------------------------------------
  function startReaderLoop(): void {
    void (async () => {
      try {
        while (!closed) {
          const line = await lineReader.nextLine();
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;

          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            // Malformed line — skip silently (bridge may have emitted a debug line)
            continue;
          }

          if (isNotification(parsed)) {
            // Dispatch to all handlers via fire-and-forget microtask.
            // This prevents a slow handler from blocking the reader loop.
            for (const handler of notificationHandlers) {
              void Promise.resolve().then(() => handler(parsed as BridgeNotification));
            }

            // Issue 13-A: when auth_required arrives, extend every pending
            // call's timeout to authTimeout so the user has time to authorize.
            if (
              typeof parsed === "object" &&
              parsed !== null &&
              "method" in parsed &&
              (parsed as Record<string, unknown>).method === "auth_required"
            ) {
              for (const [id, pending] of pendingRequests) {
                clearTimeout(pending.timer);
                pending.timer = setTimeout(() => {
                  pendingRequests.delete(id);
                  pending.reject(new Error(`Auth wait timed out after ${String(authTimeout)}ms`));
                }, authTimeout);
              }
            }
          } else if (typeof parsed === "object" && parsed !== null && "id" in parsed) {
            // Response — route to the waiting call by id.
            const id = (parsed as Record<string, unknown>).id as number;
            const pending = pendingRequests.get(id);
            if (pending !== undefined) {
              pendingRequests.delete(id);
              clearTimeout(pending.timer);
              pending.resolve(trimmed);
            }
            // id mismatch (unknown id): silently drop — the call already timed out
          }
        }
      } catch (e: unknown) {
        // Reader died (stream ended, process killed, etc.) — close and reject all.
        // Issue 16-A: guaranteed cleanup even on unexpected reader error.
        close();
        const err = e instanceof Error ? e : new Error(String(e));
        for (const [, pending] of pendingRequests) {
          pending.reject(err);
        }
        pendingRequests.clear();
      }
    })();
  }

  startReaderLoop();

  // ---------------------------------------------------------------------------
  // call() — writes one request, parks in pendingRequests until response arrives
  // ---------------------------------------------------------------------------
  function call<T>(method: string, params: Record<string, unknown>): Promise<Result<T, KoiError>> {
    if (closed) {
      return Promise.resolve({
        ok: false,
        error: { code: "INTERNAL", message: "Transport closed", retryable: false },
      });
    }

    const requestId = nextId++;
    const request = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
      id: requestId,
    });

    return new Promise<Result<T, KoiError>>((resolve) => {
      // Per-call timeout. If auth_required arrives, the timer is replaced
      // with the auth timeout (Issue 13-A) by the reader loop above.
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        // On timeout, kill the bridge so queued calls fail fast
        close();
        resolve({
          ok: false,
          error: {
            code: "TIMEOUT",
            message: `Bridge call "${method}" timed out after ${String(callTimeout)}ms`,
            retryable: true,
          },
        });
      }, callTimeout);

      pendingRequests.set(requestId, {
        resolve: (line: string) => {
          try {
            const response = JSON.parse(line) as JsonRpcResponse<T>;
            if (response.error !== undefined) {
              resolve({ ok: false, error: mapNexusError(response.error, method) });
            } else {
              resolve({ ok: true, value: response.result as T });
            }
          } catch (e: unknown) {
            resolve({ ok: false, error: mapNexusError(e, method) });
          }
        },
        reject: (e: Error) => {
          resolve({
            ok: false,
            error: closed
              ? { code: "INTERNAL", message: "Transport closed", retryable: false }
              : mapNexusError(e, method),
          });
        },
        timer,
      });

      // Write to stdin — errors are surfaced through the reader loop dying
      proc.stdin.write(`${request}\n`);
      void proc.stdin.flush();
    });
  }

  // ---------------------------------------------------------------------------
  // subscribe() — register a notification handler, return unsubscribe fn
  // ---------------------------------------------------------------------------
  function subscribe(handler: (n: BridgeNotification) => void): () => void {
    notificationHandlers.add(handler);
    return () => {
      notificationHandlers.delete(handler);
    };
  }

  // ---------------------------------------------------------------------------
  // close() — reject all pending, kill subprocess (Issue 16-A)
  // ---------------------------------------------------------------------------
  function close(): void {
    if (closed) return;
    closed = true;
    lineReader.release();

    // Reject all parked requests immediately — callers get a clean error
    // instead of hanging until their individual timers fire.
    for (const [, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Transport closed"));
    }
    pendingRequests.clear();

    try {
      proc.stdin.end();
      proc.kill();
    } catch {
      // Process may already be dead
    }
  }

  return { call, subscribe, close, mounts };
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
