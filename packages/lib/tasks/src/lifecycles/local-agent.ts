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
   * Called when the agent exits naturally (0) or fails/times-out (1).
   * NOT called on explicit cancel() — the runner already owns that transition.
   * The runner uses this callback to transition the task on the board.
   */
  readonly onExit?: ((code: number) => void) | undefined;
  /**
   * Consumer-provided runner — yields output chunks as the agent runs.
   * The signal is aborted on cancel() or timeout. The lifecycle stops consuming
   * output immediately on abort. Provide hardKill for non-cooperative agents
   * (e.g. subprocesses) that need guaranteed termination.
   */
  readonly run: (agentType: string, inputs: unknown, signal: AbortSignal) => AsyncIterable<string>;
  /**
   * Optional hard-kill path for non-cooperative agents (e.g. subprocesses).
   * Called after STOP_DRAIN_TIMEOUT_MS elapses without pipe settlement.
   * Use to force-kill external processes or workers that ignore the AbortSignal.
   */
  readonly hardKill?: (() => void) | undefined;
}

// ---------------------------------------------------------------------------
// Internal tracking
// ---------------------------------------------------------------------------

interface ActiveEntry {
  readonly pipe: Promise<void>;
  readonly hardKill: (() => void) | undefined;
}

// ---------------------------------------------------------------------------
// Output pipe helper
// ---------------------------------------------------------------------------

async function pipeAgentOutput(
  iterable: AsyncIterable<string>,
  output: TaskOutputStream,
  isHalted: () => boolean,
): Promise<void> {
  for await (const chunk of iterable) {
    // Stop consuming once halted (explicit cancel OR timeout). The iterator may
    // still be running internally — callers that need guaranteed termination
    // should provide a hardKill callback.
    if (isHalted()) break;
    output.write(chunk);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Default max time (ms) stop() waits for the pipe to settle after aborting. */
const DEFAULT_DRAIN_TIMEOUT_MS = 2000;

export interface LocalAgentLifecycleOptions {
  /** Max ms stop() waits before invoking hardKill. Default: 2000. */
  readonly drainTimeoutMs?: number | undefined;
}

export function createLocalAgentLifecycle(
  options?: LocalAgentLifecycleOptions,
): TaskKindLifecycle<LocalAgentConfig, LocalAgentTask> {
  const drainTimeoutMs = options?.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const active = new Map<TaskItemId, ActiveEntry>();

  return {
    kind: "local_agent",

    start: async (
      taskId: TaskItemId,
      output: TaskOutputStream,
      config: LocalAgentConfig,
    ): Promise<LocalAgentTask> => {
      const controller = new AbortController();

      // let justified: both flags are set-once and never reset
      let stopped = false; // explicit cancel() — suppress all callbacks
      let timedOut = false; // timeout fired — report as failure, not cancel

      // let justified: set on schedule, cleared on natural completion or cancel
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (config.timeout !== undefined) {
        timeoutId = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, config.timeout);
      }

      const iterable = config.run(config.agentType, config.inputs, controller.signal);

      const pipe = pipeAgentOutput(iterable, output, () => stopped || timedOut)
        .then(() => {
          if (stopped) return;
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          // A compliant run() may exit cleanly on abort instead of throwing —
          // timedOut still routes to failure, not success.
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
          active.delete(taskId);
        });

      active.set(taskId, { pipe, hardKill: config.hardKill });

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
      const entry = active.get(state.taskId);
      if (entry === undefined) return;

      // Race the pipe against a drain window. The loop exits immediately on
      // stopped=true, so cooperative agents settle in microseconds. For
      // non-cooperative agents, invoke hardKill after the window expires.
      const settled = await Promise.race([
        entry.pipe.then(() => true as const),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), drainTimeoutMs)),
      ]);

      if (!settled && entry.hardKill !== undefined) {
        entry.hardKill();
      }
    },
  };
}
