/**
 * RemoteAgentTask lifecycle — dispatches work to a remote agent over HTTP.
 *
 * Transport: POST to endpoint with JSON body { correlationId, payload }.
 * Response:  NDJSON stream — one JSON frame per line:
 *   { kind: "chunk", text: string }    — incremental output
 *   { kind: "done", exitCode: number } — terminal frame (required for success)
 *
 * Protocol is fail-closed: a valid `done` frame is required for any success
 * exit. Stream close without one, null bodies, malformed frames, and unknown
 * frame kinds all map to a protocol-error failure.
 *
 * SSRF boundary: the target endpoint AND all outbound headers are fixed at
 * lifecycle construction time (RemoteAgentLifecycleOptions), not supplied
 * per-task. Per-task config carries only correlationId, payload, and lifecycle
 * callbacks. This prevents per-task auth/tenant header injection from using
 * the trusted endpoint under a different backend identity.
 *
 * Cancel vs timeout:
 * - cancel() — TaskRunner.stop() owns the board transition (killOwnedTask).
 *   The lifecycle does NOT call onExit; it writes cleanup-incomplete to output.
 * - timeout — no external board transition; the lifecycle MUST call onExit(1)
 *   so TaskRunner.handleNaturalExit can fail the task on the board. Output
 *   carries the cleanup-incomplete detail to preserve the remote-uncertainty signal.
 */

import type { TaskItemId } from "@koi/core";
import type { TaskOutputStream } from "../output-stream.js";
import type { RemoteAgentTask } from "../task-kinds.js";
import type { TaskKindLifecycle } from "../task-registry.js";

// ---------------------------------------------------------------------------
// Protocol frames
// ---------------------------------------------------------------------------

type RemoteAgentFrame =
  | { readonly kind: "chunk"; readonly text: string }
  | { readonly kind: "done"; readonly exitCode: number };

function isRemoteAgentFrame(value: unknown): value is RemoteAgentFrame {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Readonly<Record<string, unknown>>;
  if (v.kind === "chunk") return typeof v.text === "string";
  if (v.kind === "done") return typeof v.exitCode === "number";
  return false;
}

// ---------------------------------------------------------------------------
// Config & options
// ---------------------------------------------------------------------------

export interface RemoteAgentConfig {
  readonly correlationId: string;
  readonly payload: unknown;
  readonly timeout?: number | undefined;
  /**
   * Called when the task reaches a confirmed terminal state:
   * - done frame received (natural completion, any exitCode)
   * - HTTP error / network error / protocol error (code 1)
   * - timeout (code 1, output also carries cleanup-incomplete detail)
   * NOT called on explicit cancel() — TaskRunner.stop() owns that board transition.
   * Called at most once. Exceptions are swallowed.
   */
  readonly onExit?: ((code: number) => void) | undefined;
}

export interface RemoteAgentLifecycleOptions {
  /**
   * Trusted remote endpoint. Fixed at lifecycle construction — not supplied
   * per-task — to enforce the SSRF boundary at wiring time.
   */
  readonly endpoint: string;
  /**
   * HTTP headers merged into every outbound request (e.g. auth tokens).
   * Fixed at lifecycle construction — not per-task — so auth/tenant context
   * cannot be overridden by less-trusted task config.
   */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Max ms to wait for the pipe to drain after abort. Default: 2000. */
  readonly drainTimeoutMs?: number | undefined;
  /** Injectable fetch implementation — defaults to globalThis.fetch. For testing. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_DRAIN_TIMEOUT_MS = 2000;
// 1 MiB per NDJSON line — protects against unbounded buffer growth from a
// server that never emits a newline.
const MAX_FRAME_BYTES = 1 * 1024 * 1024;

async function drainPipe(pipe: Promise<void>, drainTimeoutMs: number): Promise<void> {
  await Promise.race([pipe, new Promise<void>((resolve) => setTimeout(resolve, drainTimeoutMs))]);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRemoteAgentLifecycle(
  options: RemoteAgentLifecycleOptions,
): TaskKindLifecycle<RemoteAgentConfig, RemoteAgentTask> {
  const { endpoint } = options;
  const lifecycleHeaders = options.headers;
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  // Active pipe promises for stop() to await.
  const activePipes = new Map<TaskItemId, Promise<void>>();

  return {
    kind: "remote_agent",

    start: async (
      taskId: TaskItemId,
      output: TaskOutputStream,
      config: RemoteAgentConfig,
    ): Promise<RemoteAgentTask> => {
      const controller = new AbortController();

      // let justified: set-once, never reset
      let stopped = false; // explicit cancel — board transition owned by TaskRunner.stop()
      let timedOut = false; // timeout fired
      let terminal = false; // exactly-once guard

      const emitTerminal = (code: number, message: string): void => {
        if (terminal) return;
        terminal = true;
        output.write(message);
        try {
          config.onExit?.(code);
        } catch {
          // Consumer onExit must not crash the lifecycle terminal path.
        }
      };

      // let justified: pipeRef used by timeout handler; assigned immediately below.
      let pipeRef: Promise<void> | undefined;

      // let justified: cleared when task exits naturally before timeout fires.
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (config.timeout !== undefined) {
        timeoutId = setTimeout(() => {
          timedOut = true;
          controller.abort();
          void (async () => {
            if (pipeRef !== undefined) await drainPipe(pipeRef, drainTimeoutMs);
            // Timeout must call onExit so TaskRunner can fail the task on the board.
            // The cleanup-incomplete message communicates that remote termination is
            // unconfirmed — the remote agent may still be running.
            emitTerminal(1, "\n[timed out: remote agent may still be running]\n");
          })();
        }, config.timeout);
      }

      const pipe = (async (): Promise<void> => {
        let response: Response;
        try {
          response = await fetchImpl(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...lifecycleHeaders },
            body: JSON.stringify({
              correlationId: config.correlationId,
              payload: config.payload,
            }),
            signal: controller.signal,
            // Fail on redirects — prevents SSRF bypass via 3xx from trusted endpoint.
            redirect: "error",
          });
        } catch (err: unknown) {
          if (controller.signal.aborted) return;
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          const message = err instanceof Error ? err.message : String(err);
          emitTerminal(1, `\n[error: ${message}]\n`);
          return;
        }

        if (!response.ok) {
          if (controller.signal.aborted) return;
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          emitTerminal(1, `\n[error: HTTP ${String(response.status)}]\n`);
          return;
        }

        // Null body: protocol violation — server must stream a done frame.
        if (response.body === null) {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          if (!stopped && !timedOut) {
            emitTerminal(1, "\n[error: protocol error — response body is null]\n");
          }
          return;
        }

        const reader = response.body.getReader();
        // let justified: accumulates raw bytes for the current incomplete NDJSON line.
        // Byte-level scanning avoids decoding a huge string before size checks run.
        let rawBuf = new Uint8Array(0);
        let receivedDone = false;
        // let justified: set when pipe must return early (error or done).
        let pipeError = false;

        const NL = 10; // 0x0A — safe to scan in raw UTF-8 bytes (never a continuation byte)

        // Decode and process one complete NDJSON line (raw bytes, no trailing newline).
        // Abort the fetch and cancel the response body reader.
        // Called on every terminal path (done, protocol error, or unrecoverable failure)
        // so the remote agent does not keep running after the local task is finalized.
        const teardownTransport = (): void => {
          reader.cancel().catch(() => undefined);
          controller.abort();
        };

        // Returns true if the pipe should stop reading (error or done frame).
        const processLineBytes = (lineBytes: Uint8Array): boolean => {
          if (lineBytes.byteLength > MAX_FRAME_BYTES) {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
            emitTerminal(1, "\n[error: protocol error — frame exceeds maximum size]\n");
            teardownTransport();
            return true;
          }
          const trimmed = new TextDecoder().decode(lineBytes).trim();
          if (trimmed === "") return false;
          let frame: unknown;
          try {
            frame = JSON.parse(trimmed);
          } catch {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
            emitTerminal(1, "\n[error: protocol error — malformed frame]\n");
            teardownTransport();
            return true;
          }
          if (!isRemoteAgentFrame(frame)) {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
            emitTerminal(1, "\n[error: protocol error — unknown frame kind]\n");
            teardownTransport();
            return true;
          }
          if (frame.kind === "chunk") {
            output.write(frame.text);
            return false;
          }
          // done frame — hard terminal; cancel transport to stop server streaming.
          receivedDone = true;
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          const exitMsg =
            frame.exitCode === 0
              ? "\n[exit code: 0]\n"
              : `\n[exit code: ${String(frame.exitCode)}]\n`;
          emitTerminal(frame.exitCode, exitMsg);
          teardownTransport();
          return true;
        };

        try {
          outer: while (true) {
            if (stopped || timedOut) break;
            const { done, value } = await reader.read();
            // Re-check after await — timeout/cancel may have fired while read was pending.
            if (stopped || timedOut) break;
            if (done) break;

            // Scan `value` for newlines at the raw byte level — never decode the
            // full chunk. Each segment between newlines is checked and decoded
            // individually, capping per-frame allocation at MAX_FRAME_BYTES.
            let valStart = 0;
            while (valStart <= value.byteLength) {
              const nlPos = value.indexOf(NL, valStart);

              if (nlPos === -1) {
                // No more newlines — remaining bytes extend the incomplete line.
                const tailLen = value.byteLength - valStart;
                if (rawBuf.byteLength + tailLen > MAX_FRAME_BYTES) {
                  if (timeoutId !== undefined) clearTimeout(timeoutId);
                  emitTerminal(1, "\n[error: protocol error — frame exceeds maximum size]\n");
                  teardownTransport();
                  pipeError = true;
                  break outer;
                }
                const next = new Uint8Array(rawBuf.byteLength + tailLen);
                next.set(rawBuf);
                next.set(value.subarray(valStart), rawBuf.byteLength);
                rawBuf = next;
                break;
              }

              // Found newline at nlPos — complete the current line.
              const segLen = nlPos - valStart;
              const lineLen = rawBuf.byteLength + segLen;

              let lineBytes: Uint8Array;
              if (rawBuf.byteLength === 0) {
                lineBytes = value.subarray(valStart, nlPos);
              } else {
                // Guard before allocation: a cross-chunk frame could be arbitrarily
                // large; check lineLen before materializing the merged buffer.
                if (lineLen > MAX_FRAME_BYTES) {
                  if (timeoutId !== undefined) clearTimeout(timeoutId);
                  emitTerminal(1, "\n[error: protocol error — frame exceeds maximum size]\n");
                  teardownTransport();
                  pipeError = true;
                  break outer;
                }
                lineBytes = new Uint8Array(lineLen);
                lineBytes.set(rawBuf);
                lineBytes.set(value.subarray(valStart, nlPos), rawBuf.byteLength);
                rawBuf = new Uint8Array(0);
              }

              valStart = nlPos + 1;

              if (stopped || timedOut) break outer;
              if (processLineBytes(lineBytes)) {
                pipeError = true;
                break outer;
              }
            }
          }
        } catch (err: unknown) {
          if (!controller.signal.aborted && !stopped && !timedOut) {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
            const message = err instanceof Error ? err.message : String(err);
            emitTerminal(1, `\n[error: ${message}]\n`);
          }
          pipeError = true;
        } finally {
          reader.releaseLock();
        }

        if (pipeError) return;

        // Process any remaining raw bytes (done frame with no trailing newline).
        if (!stopped && !timedOut && !receivedDone && rawBuf.byteLength > 0) {
          processLineBytes(rawBuf);
        }

        // Stream closed without a done frame — protocol violation; fail closed.
        if (!stopped && !timedOut && !receivedDone) {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          emitTerminal(1, "\n[error: protocol error — stream closed without done frame]\n");
        }
      })().finally(() => {
        activePipes.delete(taskId);
      });

      pipeRef = pipe;
      activePipes.set(taskId, pipe);

      const cancel = (): void => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        stopped = true;
        controller.abort();
        // TaskRunner.stop() owns the board transition (killOwnedTask).
        // Write cleanup-incomplete to output to surface remote uncertainty,
        // but do NOT call onExit — that would double-transition the board.
        if (!terminal) {
          terminal = true;
          output.write("\n[cleanup-incomplete: remote agent may still be running]\n");
        }
      };

      return {
        kind: "remote_agent",
        taskId,
        endpoint, // from lifecycle options, not per-task config
        correlationId: config.correlationId,
        cancel,
        output,
        startedAt: Date.now(),
      };
    },

    stop: async (state: RemoteAgentTask): Promise<void> => {
      state.cancel();
      const pipe = activePipes.get(state.taskId);
      if (pipe !== undefined) await drainPipe(pipe, drainTimeoutMs);
    },
  };
}
