/**
 * LocalAgentTask lifecycle — runs a local subagent via a consumer-provided callback.
 *
 * Layer rule: @koi/tasks is L2 and cannot import @koi/engine (L1). The lifecycle
 * accepts a `run` callback so the consumer (L3/app) provides spawning logic, keeping
 * this package layer-clean. Same pattern as @koi/task-spawn.
 */

import type { TaskItemId } from "@koi/core";
import type { TaskOutputStream } from "../output-stream.js";
import type { LocalAgentTask } from "../task-kinds.js";
import type { TaskKindLifecycle } from "../task-registry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LocalAgentConfig {
  readonly agentType: string;
  /** Opaque inputs forwarded verbatim to the run callback. */
  readonly inputs: unknown;
  readonly timeout?: number | undefined;
  /**
   * Called when the agent exits — 0 for success, 1 for error/abort.
   * The runner uses this to transition the task on the board.
   */
  readonly onExit?: ((code: number) => void) | undefined;
  /**
   * Consumer-provided runner — yields output chunks as the agent runs.
   * The signal is aborted on cancel() or timeout; implementations should
   * respect it to avoid resource leaks.
   */
  readonly run: (agentType: string, inputs: unknown, signal: AbortSignal) => AsyncIterable<string>;
}

// ---------------------------------------------------------------------------
// Output pipe helper
// ---------------------------------------------------------------------------

async function pipeAgentOutput(
  iterable: AsyncIterable<string>,
  output: TaskOutputStream,
): Promise<void> {
  for await (const chunk of iterable) {
    output.write(chunk);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLocalAgentLifecycle(): TaskKindLifecycle<LocalAgentConfig, LocalAgentTask> {
  return {
    kind: "local_agent",

    start: async (
      taskId: TaskItemId,
      output: TaskOutputStream,
      config: LocalAgentConfig,
    ): Promise<LocalAgentTask> => {
      const controller = new AbortController();

      // let justified: cleared on completion to prevent double-fire
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (config.timeout !== undefined) {
        timeoutId = setTimeout(() => {
          controller.abort();
        }, config.timeout);
      }

      const iterable = config.run(config.agentType, config.inputs, controller.signal);

      void pipeAgentOutput(iterable, output)
        .then(() => {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          output.write("\n[exit code: 0]\n");
          config.onExit?.(0);
        })
        .catch((err: unknown) => {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          const message = err instanceof Error ? err.message : String(err);
          output.write(`\n[error: ${message}]\n`);
          config.onExit?.(1);
        });

      return {
        kind: "local_agent",
        taskId,
        agentType: config.agentType,
        cancel: () => {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          controller.abort();
        },
        output,
        startedAt: Date.now(),
      };
    },

    stop: async (state: LocalAgentTask): Promise<void> => {
      state.cancel();
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
  };
}
