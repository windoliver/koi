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
   * Called when the agent exits naturally (0) or fails (1).
   * NOT called on explicit cancel() — the runner already owns that transition.
   * The runner uses this callback to transition the task on the board.
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
  isStopped: () => boolean,
): Promise<void> {
  for await (const chunk of iterable) {
    if (isStopped()) break;
    output.write(chunk);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Max time (ms) stop() waits for the agent loop to drain after aborting. */
const STOP_DRAIN_TIMEOUT_MS = 2000;

export function createLocalAgentLifecycle(): TaskKindLifecycle<LocalAgentConfig, LocalAgentTask> {
  // Track per-task pipe promises so stop() can await settlement.
  const pendingPipes = new Map<TaskItemId, Promise<void>>();

  return {
    kind: "local_agent",

    start: async (
      taskId: TaskItemId,
      output: TaskOutputStream,
      config: LocalAgentConfig,
    ): Promise<LocalAgentTask> => {
      const controller = new AbortController();

      // let justified: both are set once and never decremented
      let stopped = false; // explicit cancel() — suppress all callbacks
      let timedOut = false; // timeout fired — report as failure, not cancel

      // let justified: cleared on natural completion to prevent double-fire
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (config.timeout !== undefined) {
        timeoutId = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, config.timeout);
      }

      const iterable = config.run(config.agentType, config.inputs, controller.signal);

      const pipeSettled = pipeAgentOutput(iterable, output, () => stopped)
        .then(() => {
          if (stopped) return;
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          // A compliant run() may exit cleanly on abort instead of throwing —
          // still report as timeout, not success.
          if (timedOut) {
            output.write("\n[timed out]\n");
            config.onExit?.(1);
            return;
          }
          output.write("\n[exit code: 0]\n");
          config.onExit?.(0);
        })
        .catch((err: unknown) => {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          // Explicit cancel wins — runner already owns this state transition.
          if (stopped) return;
          if (timedOut) {
            output.write("\n[timed out]\n");
            config.onExit?.(1);
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          output.write(`\n[error: ${message}]\n`);
          config.onExit?.(1);
        })
        .finally(() => {
          pendingPipes.delete(taskId);
        });

      pendingPipes.set(taskId, pipeSettled);

      const cancel = (): void => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        stopped = true;
        controller.abort();
      };

      return {
        kind: "local_agent",
        taskId,
        agentType: config.agentType,
        cancel,
        output,
        startedAt: Date.now(),
      };
    },

    stop: async (state: LocalAgentTask): Promise<void> => {
      state.cancel(); // sets stopped=true, aborts controller
      const pipe = pendingPipes.get(state.taskId);
      if (pipe !== undefined) {
        // Await pipe settlement with a bounded drain window so stop() always resolves.
        await Promise.race([
          pipe,
          new Promise<void>((resolve) => setTimeout(resolve, STOP_DRAIN_TIMEOUT_MS)),
        ]);
      }
    },
  };
}
