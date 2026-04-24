/**
 * RemoteAgentTask lifecycle — dispatches work to a remote agent over HTTP.
 *
 * Transport: POST to endpoint with JSON body { correlationId, payload }.
 * Response:  NDJSON stream — one JSON frame per line:
 *   { kind: "chunk", text: string }   — incremental output
 *   { kind: "done", exitCode: number } — terminal frame (optional)
 *
 * If the stream closes without a done frame, exitCode defaults to 0.
 * Non-2xx responses and network errors map to exitCode 1.
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
   * Called when the task exits naturally or times out.
   * NOT called on explicit cancel(). Called at most once.
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

      // let justified: all three are set-once, never reset
      let stopped = false;
      let timedOut = false;
      let terminal = false;

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
            emitTerminal(1, "\n[timed out]\n");
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
          emitTerminal(1, `\n[error: ${message}]\n`);
          return;
        }

        if (!response.ok) {
          if (controller.signal.aborted) return;
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          emitTerminal(1, `\n[error: HTTP ${String(response.status)}]\n`);
          return;
        }

        if (response.body === null) {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          if (!stopped && !timedOut) emitTerminal(0, "\n[exit code: 0]\n");
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

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
                continue; // malformed — skip silently
              }
              if (!isRemoteAgentFrame(frame)) continue;
              if (frame.kind === "chunk") {
                output.write(frame.text);
              } else {
                if (timeoutId !== undefined) clearTimeout(timeoutId);
                const exitMsg =
                  frame.exitCode === 0
                    ? "\n[exit code: 0]\n"
                    : `\n[exit code: ${String(frame.exitCode)}]\n`;
                emitTerminal(frame.exitCode, exitMsg);
              }
            }
          }
        } catch (err: unknown) {
          if (!controller.signal.aborted && !stopped && !timedOut) {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
            const message = err instanceof Error ? err.message : String(err);
            emitTerminal(1, `\n[error: ${message}]\n`);
          }
        } finally {
          reader.releaseLock();
        }

        // Stream closed without a done frame.
        if (!stopped && !timedOut) {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          emitTerminal(0, "\n[exit code: 0]\n");
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
