/**
 * RemoteAgentTask lifecycle — dispatches work to a remote agent over HTTP.
 *
 * Transport: POST to endpoint with JSON body { correlationId, payload }.
 * Response:  NDJSON stream — one JSON frame per line:
 *   { kind: "chunk", text: string }    — incremental output
 *   { kind: "done", exitCode: number } — terminal frame (required for success)
 *
 * Protocol is fail-closed: a valid `done` frame is required for any success
 * exit. All stream-phase failures (malformed frames, unknown frame kinds, size
 * violations, connection drops, stream close without done) emit cleanup-incomplete
 * because the POST was already accepted — the remote agent has started and its
 * state after local abort is unknown. Pre-response failures (network error before
 * response, non-OK HTTP status) emit [error: ...] because the remote never started.
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
   * Optional cancellation endpoint. When set, cancel/timeout sends a
   * fire-and-forget POST to this URL with `{ correlationId }` so the remote
   * server can stop the associated work. Same HTTPS rules as `endpoint`.
   * Subject to same lifecycle `headers`. Failures are swallowed — the
   * cleanup-incomplete signal already covers uncertain remote state.
   */
  readonly cancelEndpoint?: string | undefined;
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

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// Enforce HTTPS at lifecycle construction time so auth headers and task payloads
// are never sent over a plaintext transport. Plain HTTP is permitted only for
// loopback addresses (local dev / integration testing).
function validateEndpointSecurity(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`RemoteAgentLifecycle: invalid endpoint URL: ${JSON.stringify(endpoint)}`);
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname)) return;
  throw new Error(
    `RemoteAgentLifecycle: endpoint must use HTTPS (got ${url.protocol}//${url.hostname}). ` +
      "Plain HTTP is only permitted for loopback addresses (localhost, 127.0.0.1, ::1).",
  );
}

async function drainPipe(pipe: Promise<void>, drainTimeoutMs: number): Promise<void> {
  await Promise.race([pipe, new Promise<void>((resolve) => setTimeout(resolve, drainTimeoutMs))]);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRemoteAgentLifecycle(
  options: RemoteAgentLifecycleOptions,
): TaskKindLifecycle<RemoteAgentConfig, RemoteAgentTask> {
  validateEndpointSecurity(options.endpoint);
  if (options.cancelEndpoint !== undefined) validateEndpointSecurity(options.cancelEndpoint);
  const { endpoint } = options;
  const cancelEndpoint = options.cancelEndpoint;
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

      // Best-effort cancel notification: fire-and-forget POST to cancelEndpoint on every
      // post-accept terminal failure so the remote server can stop the associated work.
      // taskId is included to distinguish retries sharing the same correlationId.
      const notifyCancel = (): void => {
        if (cancelEndpoint !== undefined) {
          void fetchImpl(cancelEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...lifecycleHeaders },
            body: JSON.stringify({ correlationId: config.correlationId, taskId }),
            redirect: "error",
          }).catch(() => undefined);
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
            // If a done frame raced the abort and was processed before the
            // connection was killed, terminal is already set — emitTerminal is
            // a no-op.  Snapshot before the call to know whether we committed.
            const timedOutBeforeDone = !terminal;
            emitTerminal(1, "\n[timed out: remote agent may still be running]\n");
            // Only send cancel if we actually committed to timeout failure.
            // If a done frame beat the abort (narrow race), sending cancel
            // would interfere with work the remote side completed successfully.
            if (timedOutBeforeDone) notifyCancel();
            // Force-remove from activePipes even if the pipe never settled — same
            // as stop() does. handleNaturalExit does not call stop(), so without
            // this, timed-out hung tasks would leak map entries indefinitely.
            activePipes.delete(taskId);
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
          // POST body may have been sent before the network error — remote state unknown.
          notifyCancel();
          emitTerminal(1, `\n[cleanup-incomplete: ${message}]\n`);
          return;
        }

        if (!response.ok) {
          if (controller.signal.aborted) return;
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          // 5xx can be returned after work started; treat all non-OK as cleanup-incomplete.
          notifyCancel();
          emitTerminal(1, `\n[cleanup-incomplete: HTTP ${String(response.status)}]\n`);
          return;
        }

        // Null body: 200 accepted but no stream — remote agent state is unknown.
        if (response.body === null) {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          if (!stopped && !timedOut) {
            notifyCancel();
            emitTerminal(1, "\n[cleanup-incomplete: protocol error — response body is null]\n");
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
            notifyCancel();
            emitTerminal(
              1,
              "\n[cleanup-incomplete: protocol error — frame exceeds maximum size]\n",
            );
            teardownTransport();
            return true;
          }
          let trimmed: string;
          try {
            // fatal: true — invalid UTF-8 bytes throw instead of silently replacing with U+FFFD,
            // which could allow wire corruption to masquerade as valid frames.
            trimmed = new TextDecoder("utf-8", { fatal: true }).decode(lineBytes).trim();
          } catch {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
            notifyCancel();
            emitTerminal(1, "\n[cleanup-incomplete: protocol error — invalid UTF-8]\n");
            teardownTransport();
            return true;
          }
          if (trimmed === "") return false;
          let frame: unknown;
          try {
            frame = JSON.parse(trimmed);
          } catch {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
            notifyCancel();
            emitTerminal(1, "\n[cleanup-incomplete: protocol error — malformed frame]\n");
            teardownTransport();
            return true;
          }
          if (!isRemoteAgentFrame(frame)) {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
            notifyCancel();
            emitTerminal(1, "\n[cleanup-incomplete: protocol error — unknown frame kind]\n");
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
            if (stopped) break;
            const { done, value } = await reader.read();
            // Only break on explicit cancel — if timedOut, still process already-received
            // data so a done frame in the buffer can win over the synthetic timeout failure.
            if (stopped) break;
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
                  notifyCancel();
                  emitTerminal(
                    1,
                    "\n[cleanup-incomplete: protocol error — frame exceeds maximum size]\n",
                  );
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
                  notifyCancel();
                  emitTerminal(
                    1,
                    "\n[cleanup-incomplete: protocol error — frame exceeds maximum size]\n",
                  );
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

              if (stopped) break outer;
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
            // POST was accepted so the remote agent has started; transport loss
            // leaves it in an unknown state — signal cleanup-incomplete.
            notifyCancel();
            emitTerminal(1, `\n[cleanup-incomplete: ${message}]\n`);
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

        // Stream closed without a done frame — remote state unknown; cleanup-incomplete.
        if (!stopped && !timedOut && !receivedDone) {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          notifyCancel();
          emitTerminal(
            1,
            "\n[cleanup-incomplete: protocol error — stream closed without done frame]\n",
          );
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
        // Best-effort cancel notification — same as timeout path.
        notifyCancel();
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
      // Force-remove even if the pipe promise never settled within the drain window.
      // Without this, a hung connection would retain the taskId in activePipes
      // after the board has already transitioned to a terminal state.
      activePipes.delete(state.taskId);
    },
  };
}
