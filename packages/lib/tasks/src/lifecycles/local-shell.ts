/**
 * LocalShellTask lifecycle — spawns a shell process and streams output.
 *
 * First concrete TaskKindLifecycle implementation. Validates the registry/runner
 * stack works end-to-end with real process management.
 */

import type { TaskItemId } from "@koi/core";
import type { TaskOutputStream } from "../output-stream.js";
import type { LocalShellTask } from "../task-kinds.js";
import type { TaskKindLifecycle } from "../task-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LocalShellConfig {
  readonly command: string;
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly timeout?: number | undefined;
  /**
   * Called when the subprocess exits naturally.
   * The runner uses this to transition the task on the board.
   */
  readonly onExit?: (code: number) => void;
}

// ---------------------------------------------------------------------------
// Stream piping helper
// ---------------------------------------------------------------------------

async function pipeStream(
  stream: ReadableStream<Uint8Array> | null,
  output: TaskOutputStream,
): Promise<void> {
  if (stream === null) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        output.write(decoder.decode(value, { stream: true }));
      }
    }
    // Flush any remaining bytes buffered in the decoder (e.g. split multibyte chars)
    const trailing = decoder.decode();
    if (trailing.length > 0) {
      output.write(trailing);
    }
  } catch {
    // Stream may be closed when process is killed — swallow
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLocalShellLifecycle(): TaskKindLifecycle<LocalShellConfig, LocalShellTask> {
  return {
    kind: "local_shell",

    start: async (
      taskId: TaskItemId,
      output: TaskOutputStream,
      config: LocalShellConfig,
    ): Promise<LocalShellTask> => {
      const controller = new AbortController();

      const spawnOptions: {
        cwd?: string;
        env?: Record<string, string | undefined>;
        stdout: "pipe";
        stderr: "pipe";
        signal: AbortSignal;
      } = {
        stdout: "pipe",
        stderr: "pipe",
        signal: controller.signal,
      };
      if (config.cwd !== undefined) spawnOptions.cwd = config.cwd;
      if (config.env !== undefined) spawnOptions.env = { ...process.env, ...config.env };

      const proc = Bun.spawn(["sh", "-c", config.command], spawnOptions);

      // Pipe stdout and stderr to the output stream (fire-and-forget)
      void pipeStream(proc.stdout, output);
      void pipeStream(proc.stderr, output);

      // Optional timeout
      // let justified: mutable because it's set conditionally and cleared on exit
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (config.timeout !== undefined) {
        timeoutId = setTimeout(() => {
          controller.abort();
        }, config.timeout);
      }

      // Write exit code when process completes and notify runner
      void proc.exited.then((code) => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        output.write(`\n[exit code: ${String(code)}]\n`);
        config.onExit?.(code);
      });

      return {
        kind: "local_shell",
        taskId,
        command: config.command,
        cancel: () => {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          controller.abort();
        },
        output,
        startedAt: Date.now(),
      };
    },

    stop: async (state: LocalShellTask): Promise<void> => {
      state.cancel();
      // Give the process a moment to clean up
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
  };
}
