/**
 * LocalShellTask lifecycle — spawns a shell process and streams output.
 *
 * First concrete TaskKindLifecycle implementation. Validates the registry/runner
 * stack works end-to-end with real process management.
 */

import type { Subprocess } from "bun";
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

      const proc = Bun.spawn(["sh", "-c", config.command], {
        cwd: config.cwd,
        env: config.env !== undefined ? { ...process.env, ...config.env } : undefined,
        stdout: "pipe",
        stderr: "pipe",
        signal: controller.signal,
      });

      // Pipe stdout and stderr to the output stream (fire-and-forget)
      void pipeStream(proc.stdout, output);
      void pipeStream(proc.stderr, output);

      // Write exit code when process completes
      void proc.exited.then((code) => {
        output.write(`\n[exit code: ${String(code)}]\n`);
      });

      // Optional timeout
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (config.timeout !== undefined) {
        timeoutId = setTimeout(() => {
          controller.abort();
        }, config.timeout);
      }

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
