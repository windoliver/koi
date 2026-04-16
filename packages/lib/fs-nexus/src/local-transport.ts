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

import { fileURLToPath } from "node:url";
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
// fileURLToPath handles Windows drive letters (/C:/...) and URL-encoded spaces
// that URL.pathname leaves encoded, making Bun.spawn unable to locate the file.
const BRIDGE_PATH = fileURLToPath(new URL("./bridge.py", import.meta.url));

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

  // Wait for the "ready" signal from the bridge.
  // Any failure here (timeout, process exit, parse error) must clean up the
  // subprocess — without this, a repeated startup failure leaks processes.
  let mounts: readonly string[] = [];
  try {
    const readyLine = await Promise.race([
      lineReader.nextLine(),
      rejectAfter(startupTimeout, "Bridge process did not start within timeout"),
      procExit(proc),
    ]);

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
    // If stderr drain timed out, the process ignored SIGTERM — force kill it.
    try {
      proc.kill(9);
    } catch {
      // Already dead — ignore.
    }
    throw new Error(
      `Failed to start nexus-fs bridge: ${e instanceof Error ? e.message : String(e)}${stderr ? `\nstderr: ${stderr}` : ""}`,
      { cause: e },
    );
  }

  let nextId = 1;
  let closed = false;

  // Serial call queue — the Python bridge processes one stdin line at a time.
  // Concurrent calls would interleave their requests, making response routing
  // ambiguous. The background reader loop handles notifications that arrive
  // while a request is in-flight, but only one request may be in-flight at once.
  // Consequence: one auth challenge on any mount blocks all subsequent calls
  // until auth completes or times out. This is a known property of the serial
  // bridge architecture and must be documented at the call site.
  let callQueue: Promise<unknown> = Promise.resolve();

  // Pending request map — at most one entry at a time (enforced by callQueue).
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
            // Malformed post-startup JSON is a fatal protocol error.
            // The bridge has corrupted the stdout channel — silently skipping
            // would leave the in-flight request hanging until timeout.
            // Throw to trigger the catch path, which calls close() and rejects
            // all pending requests immediately with the offending line for diagnostics.
            throw new Error(`Bridge sent malformed JSON: ${trimmed.slice(0, 200)}`);
          }

          if (isNotification(parsed)) {
            // Dispatch to all handlers via fire-and-forget microtask.
            // This prevents a slow handler from blocking the reader loop.
            for (const handler of notificationHandlers) {
              void Promise.resolve().then(() => handler(parsed as BridgeNotification));
            }

            // On auth_required: clear the per-call timer and let the bridge own
            // the deadline. The bridge uses NEXUS_AUTH_TIMEOUT_MS and will always
            // send a JSON-RPC response — either a success result or a -32007
            // AUTH_TIMEOUT error — so the pending call will resolve correctly.
            // Setting a parallel local timer would race the bridge and misclassify
            // the error; not setting one avoids the race and prevents unrelated
            // in-flight requests from having their deadlines silently extended.
            if (
              typeof parsed === "object" &&
              parsed !== null &&
              "method" in parsed &&
              (parsed as Record<string, unknown>).method === "auth_required"
            ) {
              for (const [, pending] of pendingRequests) {
                clearTimeout(pending.timer);
                // Timer is intentionally not replaced — bridge owns the deadline.
                // If the bridge process dies, the reader loop catch path rejects all pending.
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
        // Reader died (stream ended, process killed, protocol error, etc.).
        // Capture the real cause BEFORE calling close(), which clears pendingRequests.
        const err = e instanceof Error ? e : new Error(String(e));
        const snapshot = [...pendingRequests.values()];
        pendingRequests.clear(); // prevent close() from double-rejecting
        close();
        for (const pending of snapshot) {
          pending.reject(err);
        }
      }
    })();
  }

  startReaderLoop();

  // ---------------------------------------------------------------------------
  // call() — serialized via callQueue; one request in-flight at a time.
  // The background reader loop handles notifications that arrive mid-call.
  // ---------------------------------------------------------------------------
  function call<T>(method: string, params: Record<string, unknown>): Promise<Result<T, KoiError>> {
    if (closed) {
      return Promise.resolve({
        ok: false,
        error: { code: "INTERNAL", message: "Transport closed", retryable: false },
      });
    }

    // Chain onto the queue — ensures only one request is in-flight at a time.
    const result = callQueue.then((): Promise<Result<T, KoiError>> => {
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
        // Per-call timeout. When auth_required arrives, the reader loop clears
        // this timer and cedes deadline ownership to the bridge (which uses
        // NEXUS_AUTH_TIMEOUT_MS). Since calls are serialized, only this one
        // pending entry exists when auth_required fires, so clearing all timers
        // in pendingRequests is safe and scoped to exactly this call.
        const timer = setTimeout(() => {
          pendingRequests.delete(requestId);
          // Kill bridge so queued calls fail fast rather than waiting.
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
            // Always surface the actual error — the reader loop captures the
            // real cause (protocol error, malformed JSON, EOF) before calling
            // close(), so we must not replace it with the generic "Transport
            // closed" message that the closed flag would produce.
            resolve({
              ok: false,
              error: mapNexusError(e, method),
            });
          },
          timer,
        });

        // Write to stdin. Synchronous write errors (bridge exited, pipe closed)
        // are caught and resolved as a transport error. flush() is fire-and-forget
        // but its rejections are routed through close() → reader-loop cleanup.
        // Write and flush to stdin. Both are synchronous in Bun. Catch write
        // errors and resolve the pending request with a transport error instead
        // of letting the exception propagate as an unhandled rejection.
        try {
          proc.stdin.write(`${request}\n`);
          proc.stdin.flush();
        } catch (writeErr: unknown) {
          pendingRequests.delete(requestId);
          clearTimeout(timer);
          close();
          resolve({ ok: false, error: mapNexusError(writeErr, method) });
          return;
        }
      });
    });

    // Swallow errors so the queue chain never rejects.
    callQueue = result.catch(() => {});
    return result;
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
  // close() — reject all pending, graceful bridge shutdown (Issue 16-A)
  // ---------------------------------------------------------------------------

  /** Hard cap on how long we wait for the bridge to exit after stdin EOF. */
  const GRACEFUL_SHUTDOWN_MS = 2000;

  function close(): void {
    if (closed) return;
    closed = true;

    try {
      lineReader.release();
    } catch {
      // Ignore — we're shutting down regardless.
    }

    for (const [, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Transport closed"));
    }
    pendingRequests.clear();

    // Graceful shutdown: end stdin so the bridge's main loop sees EOF and
    // proceeds to `await fs.close()` for CAS cleanup / unmount. A kill
    // timer fires after GRACEFUL_SHUTDOWN_MS as a safety net — if the
    // bridge exits on its own before the timer, the kill is cancelled.
    try {
      proc.stdin.end();
    } catch {
      // stdin may already be closed or process dead — fall through to kill.
      try {
        proc.kill();
      } catch {
        // Already dead.
      }
      return;
    }

    const killTimer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // Already exited.
      }
    }, GRACEFUL_SHUTDOWN_MS);

    void proc.exited.then(() => clearTimeout(killTimer)).catch(() => clearTimeout(killTimer));
  }

  // ---------------------------------------------------------------------------
  // submitAuthCode() — forward pasted redirect URL to bridge (remote OAuth flow)
  // ---------------------------------------------------------------------------
  function submitAuthCode(redirectUrl: string, correlationId?: string): void {
    if (closed) return;
    const msg = JSON.stringify({
      jsonrpc: "2.0",
      method: "auth_submit",
      params: {
        redirect_url: redirectUrl,
        ...(correlationId !== undefined ? { correlation_id: correlationId } : {}),
      },
    });
    try {
      proc.stdin.write(`${msg}\n`);
      proc.stdin.flush();
    } catch {
      // flush() is synchronous in Bun — write errors mean bridge is gone.
      close();
    }
  }

  return { call, subscribe, submitAuthCode, close, mounts };
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

/** Max bytes to capture from stderr before truncating. */
const MAX_STDERR_BYTES = 256 * 1024; // 256 KiB

/** Max time to wait for stderr EOF after process kill (ms). */
const STDERR_DRAIN_TIMEOUT_MS = 3_000;

/** Collect stderr output for error messages. Drains until EOF, with bounded time and size. */
async function collectStderr(proc: {
  readonly stderr: ReadableStream<Uint8Array>;
}): Promise<string> {
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let bytes = 0;
  let truncated = false;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const drain = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value !== undefined) {
          const remaining = MAX_STDERR_BYTES - bytes;
          bytes += value.byteLength;
          if (bytes > MAX_STDERR_BYTES) {
            // Clip the overflow chunk to fit within the cap
            output += decoder.decode(value.subarray(0, remaining), { stream: true });
            truncated = true;
            break;
          }
          output += decoder.decode(value, { stream: true });
        }
      }
    })();

    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), STDERR_DRAIN_TIMEOUT_MS);
    });

    const result = await Promise.race([drain.then(() => "done" as const), timeout]);
    timedOut = result === "timeout";
  } catch {
    // Stream error — use whatever we collected so far
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      // Ignore — may already be released after cancel
    }
  }

  // Flush any remaining bytes in the decoder
  output += decoder.decode();
  const trimmed = output.trim();

  if (truncated) {
    return `${trimmed}\n[truncated — exceeded ${String(MAX_STDERR_BYTES)} bytes]`;
  }
  if (timedOut) {
    return trimmed.length > 0
      ? `${trimmed}\n[truncated — stderr drain timed out]`
      : "[stderr drain timed out — process may have ignored SIGTERM]";
  }
  return trimmed;
}
