/**
 * RemoteAgentTask lifecycle — dispatches work to a remote agent over HTTP.
 *
 * Transport: POST to endpoint with JSON body { correlationId, payload }.
 * Response:  NDJSON stream — one JSON frame per line:
 *   { kind: "chunk", text: string }    — incremental output
 *   { kind: "done", exitCode: number } — terminal frame (required for success)
 *
 * Protocol is fail-closed: a valid `done` frame is required for any success
 * exit. Stream close without one, null bodies, and malformed frames all map
 * to a protocol-error failure. Non-2xx responses and network errors also fail.
 *
 * Remote cancellation: aborting the local fetch terminates the HTTP connection
 * but cannot confirm the remote agent has stopped. Stop/timeout emit a
 * cleanup-incomplete marker and do NOT call onExit — callers must treat
 * cleanup-incomplete tasks as potentially still running remotely.
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
  readonly endpoint: string;
  readonly correlationId: string;
  readonly payload: unknown;
  readonly timeout?: number | undefined;
  /** Extra HTTP headers forwarded to the remote endpoint (e.g. auth). */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /**
   * Called when the task exits with a confirmed done frame (exit 0 or non-zero).
   * NOT called on cancel() or timeout — those paths produce cleanup-incomplete
   * state because remote termination cannot be confirmed. Called at most once.
   * Exceptions are swallowed.
   */
  readonly onExit?: ((code: number) => void) | undefined;
}

export interface RemoteAgentLifecycleOptions {
  /** Max ms to wait for the pipe to drain after abort before declaring done. Default: 2000. */
  readonly drainTimeoutMs?: number | undefined;
  /** Injectable fetch implementation — defaults to globalThis.fetch. For testing. */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_DRAIN_TIMEOUT_MS = 2000;

async function drainPipe(pipe: Promise<void>, drainTimeoutMs: number): Promise<void> {
  await Promise.race([pipe, new Promise<void>((resolve) => setTimeout(resolve, drainTimeoutMs))]);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRemoteAgentLifecycle(
  options?: RemoteAgentLifecycleOptions,
): TaskKindLifecycle<RemoteAgentConfig, RemoteAgentTask> {
  const drainTimeoutMs = options?.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const fetchImpl = options?.fetch ?? globalThis.fetch;

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
      let stopped = false; // explicit cancel — suppresses all callbacks
      let timedOut = false; // timeout fired — produces cleanup-incomplete, not onExit
      let terminal = false; // exactly-once guard

      const emitTerminal = (code: number, message: string, callOnExit: boolean): void => {
        if (terminal) return;
        terminal = true;
        output.write(message);
        if (!callOnExit) return;
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
            // Timeout cannot confirm remote stopped — emit cleanup-incomplete, no onExit.
            emitTerminal(1, "\n[timed out: remote agent may still be running]\n", false);
          })();
        }, config.timeout);
      }

      const pipe = (async (): Promise<void> => {
        let response: Response;
        try {
          response = await fetchImpl(config.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...config.headers },
            body: JSON.stringify({
              correlationId: config.correlationId,
              payload: config.payload,
            }),
            signal: controller.signal,
          });
        } catch (err: unknown) {
          if (controller.signal.aborted) return;
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          const message = err instanceof Error ? err.message : String(err);
          emitTerminal(1, `\n[error: ${message}]\n`, true);
          return;
        }

        if (!response.ok) {
          if (controller.signal.aborted) return;
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          emitTerminal(1, `\n[error: HTTP ${String(response.status)}]\n`, true);
          return;
        }

        // Null body: protocol violation — server must stream a done frame.
        if (response.body === null) {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          if (!stopped && !timedOut) {
            emitTerminal(1, "\n[error: protocol error — response body is null]\n", true);
          }
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let receivedDone = false;

        try {
          while (true) {
            if (stopped || timedOut) break;
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            // last element is the incomplete line remainder
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (stopped || timedOut) break;
              const trimmed = line.trim();
              if (trimmed === "") continue;
              let frame: unknown;
              try {
                frame = JSON.parse(trimmed);
              } catch {
                // Malformed JSON — protocol violation; fail closed.
                if (timeoutId !== undefined) clearTimeout(timeoutId);
                emitTerminal(1, "\n[error: protocol error — malformed frame]\n", true);
                return;
              }
              if (!isRemoteAgentFrame(frame)) {
                // Valid JSON but unrecognised shape — skip silently; remote may
                // emit metadata frames we don't understand yet.
                continue;
              }
              if (frame.kind === "chunk") {
                output.write(frame.text);
              } else {
                // done is a hard terminal — stop reading immediately.
                receivedDone = true;
                if (timeoutId !== undefined) clearTimeout(timeoutId);
                const exitMsg =
                  frame.exitCode === 0
                    ? "\n[exit code: 0]\n"
                    : `\n[exit code: ${String(frame.exitCode)}]\n`;
                emitTerminal(frame.exitCode, exitMsg, true);
                return; // exit pipe; finally{} releases reader lock
              }
            }
          }
        } catch (err: unknown) {
          if (!controller.signal.aborted && !stopped && !timedOut) {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
            const message = err instanceof Error ? err.message : String(err);
            emitTerminal(1, `\n[error: ${message}]\n`, true);
          }
        } finally {
          reader.releaseLock();
        }

        // Process any remaining buffer content (done frame with no trailing newline).
        if (!stopped && !timedOut && !receivedDone && buffer.trim() !== "") {
          let frame: unknown;
          try {
            frame = JSON.parse(buffer.trim());
          } catch {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
            emitTerminal(1, "\n[error: protocol error — malformed frame]\n", true);
          }
          if (frame !== undefined && isRemoteAgentFrame(frame) && frame.kind === "done") {
            receivedDone = true;
            if (timeoutId !== undefined) clearTimeout(timeoutId);
            const exitMsg =
              frame.exitCode === 0
                ? "\n[exit code: 0]\n"
                : `\n[exit code: ${String(frame.exitCode)}]\n`;
            emitTerminal(frame.exitCode, exitMsg, true);
          }
        }

        // Stream closed without a done frame — protocol violation; fail closed.
        if (!stopped && !timedOut && !receivedDone) {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          emitTerminal(1, "\n[error: protocol error — stream closed without done frame]\n", true);
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
        // Remote cleanup cannot be confirmed — emit cleanup-incomplete marker.
        // emitTerminal is called after abort so the pipe can settle; write
        // directly here to surface the state even if the pipe has already exited.
        if (!terminal) {
          terminal = true;
          output.write("\n[cleanup-incomplete: remote agent may still be running]\n");
          // onExit intentionally NOT called — remote termination unconfirmed.
        }
      };

      return {
        kind: "remote_agent",
        taskId,
        endpoint: config.endpoint,
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
