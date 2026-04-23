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
   * Called at most once. Exceptions are swallowed — they must not escape the
   * lifecycle's terminal transition.
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
   * Called after DRAIN_TIMEOUT_MS elapses without pipe settlement.
   * Use to force-kill external processes or workers that ignore the AbortSignal.
   * Exceptions are swallowed — they must not escape cleanup paths.
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
    // Stop consuming once halted (explicit cancel OR timeout).
    if (isHalted()) break;
    output.write(chunk);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeHardKill(fn: (() => void) | undefined): void {
  if (fn === undefined) return;
  try {
    fn();
  } catch {
    // Consumer-provided kills can throw on already-exited processes — swallow.
  }
}

/**
 * Wait for the pipe to settle, optionally invoking hardKill if it doesn't.
 * Returns true if pipe settled (agent is confirmed stopped), false otherwise.
 * Callers must treat false as "agent may still be running".
 */
async function drainOrKill(
  pipe: Promise<void>,
  drainTimeoutMs: number,
  hardKill: (() => void) | undefined,
): Promise<boolean> {
  const settled = await Promise.race([
    pipe.then(() => true as const),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), drainTimeoutMs)),
  ]);
  if (settled) return true;
  safeHardKill(hardKill);
  if (hardKill !== undefined) {
    // Give the iterator one more window to settle after hard kill before
    // declaring the task dead. Prevents terminal state racing a still-running
    // agent when hardKill works cooperatively (e.g. SIGKILL on a subprocess).
    const postKillSettled = await Promise.race([
      pipe.then(() => true as const),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), drainTimeoutMs)),
    ]);
    return postKillSettled;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Default max time (ms) drain window waits before invoking hardKill. */
const DEFAULT_DRAIN_TIMEOUT_MS = 2000;

export interface LocalAgentLifecycleOptions {
  /** Max ms the drain window waits before invoking hardKill. Default: 2000. */
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

      // let justified: all three are set-once, never reset
      let stopped = false; // explicit cancel() — suppress all callbacks
      let timedOut = false; // timeout fired — result emitted after drain attempt
      let terminal = false; // exactly-once guard for onExit + terminal message

      const emitTerminal = (code: number, message: string): void => {
        if (terminal) return;
        terminal = true;
        output.write(message);
        try {
          config.onExit?.(code);
        } catch {
          // Consumer onExit must not crash the lifecycle's terminal path.
        }
        // NOTE: active entry is intentionally NOT deleted here. For unconfirmed
        // cleanup (stuck generators), the entry stays so stop() retries are safe.
        // pipe.finally() handles deletion once the iterator actually settles.
      };

      // Deferred pipe reference so the timeout handler can await it.
      // let justified: assigned immediately after pipe is created below.
      let pipeRef: Promise<void> | undefined;

      // let justified: set on schedule, cleared if cancel() fires first
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (config.timeout !== undefined) {
        timeoutId = setTimeout(() => {
          timedOut = true;
          controller.abort();
          // Bounded drain before marking terminal — attempt cleanup first so
          // the task is not declared dead while the agent is still running.
          void (async () => {
            const cleaned =
              pipeRef !== undefined
                ? await drainOrKill(pipeRef, drainTimeoutMs, config.hardKill)
                : true;
            // Distinct message when cleanup could not be confirmed — signals
            // that the underlying agent may still be running.
            const msg = cleaned ? "\n[timed out]\n" : "\n[timed out: cleanup incomplete]\n";
            emitTerminal(1, msg);
          })();
        }, config.timeout);
      }

      const iterable = config.run(config.agentType, config.inputs, controller.signal);

      const pipe = pipeAgentOutput(iterable, output, () => stopped || timedOut)
        .then(() => {
          if (stopped || timedOut) return; // cancel or timeout handles terminal
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          emitTerminal(0, "\n[exit code: 0]\n");
        })
        .catch((err: unknown) => {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          if (stopped || timedOut) return; // cancel or timeout handles terminal
          const message = err instanceof Error ? err.message : String(err);
          emitTerminal(1, `\n[error: ${message}]\n`);
        })
        .finally(() => {
          active.delete(taskId);
        });

      pipeRef = pipe;
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
      await drainOrKill(entry.pipe, drainTimeoutMs, entry.hardKill);
    },
  };
}
