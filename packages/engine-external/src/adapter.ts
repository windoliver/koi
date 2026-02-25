/**
 * External process engine adapter factory.
 *
 * Wraps any external process (CLI tool, domain expert, research bot) as an
 * EngineAdapter via Bun.spawn(). Maps stdout/stderr to EngineEvent stream,
 * process lifecycle to agent lifecycle, stdin to mid-task redirection.
 *
 * Supports two modes:
 * - single-shot: spawn per stream() call, stdin closed after input, process exit = done
 * - long-lived: persistent process across stream() calls, parser-driven turn completion
 */

import type {
  ContentBlock,
  EngineEvent,
  EngineInput,
  EngineMetrics,
  EngineOutput,
  EngineState,
  EngineStopReason,
} from "@koi/core";
import { createAsyncQueue } from "./async-queue.js";
import { resolveEnv } from "./env.js";
import { createTextDeltaParser } from "./parsers.js";
import { killProcess, readStream, spawnProcess } from "./process-manager.js";
import type {
  ExternalAdapterConfig,
  ExternalEngineAdapter,
  ExternalProcessState,
  ManagedProcess,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENGINE_ID = "external" as const;
const DEFAULT_TIMEOUT_MS = 300_000 as const; // 5 minutes
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576 as const; // 1 MiB
const DEFAULT_MAX_HISTORY_ENTRIES = 10_000 as const;
const TEXT_ENCODER = new TextEncoder();

// ---------------------------------------------------------------------------
// Input extraction
// ---------------------------------------------------------------------------

/**
 * Extract text input from EngineInput. Falls back to concatenating message
 * content blocks for the "messages" variant.
 */
function extractInputText(input: EngineInput): string {
  switch (input.kind) {
    case "text":
      return input.text;
    case "messages": {
      const parts: string[] = [];
      for (const msg of input.messages) {
        for (const block of msg.content) {
          if (block.kind === "text") {
            parts.push(block.text);
          }
        }
      }
      return parts.join("\n");
    }
    case "resume":
      return "";
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an external process engine adapter.
 */
export function createExternalAdapter(config: ExternalAdapterConfig): ExternalEngineAdapter {
  const command = config.command;
  const args = config.args ?? [];
  const cwd = config.cwd ?? process.cwd();
  const env = resolveEnv(config.env);
  const parserFactory = config.parser ?? createTextDeltaParser();
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const noOutputTimeoutMs = config.noOutputTimeoutMs ?? 0;
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const shutdown = config.shutdown;
  const mode = config.mode ?? "single-shot";

  // let: lifecycle flag — toggled once by dispose()
  let disposed = false;
  // let: concurrency guard for single-shot mode
  let running = false;
  // let: persistent process for long-lived mode
  let currentProcess: ManagedProcess | undefined;
  // let: output history for saveState (mutated via push — internal state, defensively copied in saveState/loadState)
  let outputHistory: string[] = [];

  // --- Long-lived mode: persistent dispatch handlers ---
  // These are set by each stream() call and cleared when the turn ends.
  // The persistent readers (started once at spawn) call through these.
  // let: current-turn stdout handler
  let onStdoutChunk: ((text: string) => void) | undefined;
  // let: current-turn stderr handler
  let onStderrChunk: ((text: string) => void) | undefined;
  // let: called when process exits unexpectedly during a turn
  let onProcessExit: (() => void) | undefined;
  // let: called by dispose() to end the current turn immediately
  let currentFinishTurn: ((reason: EngineStopReason) => void) | undefined;
  // let: set once when persistent readers are started
  let persistentReadersStarted = false;

  /**
   * Start persistent readers on stdout/stderr that dispatch to the current
   * turn handlers. Called once when the long-lived process is spawned.
   */
  function startPersistentReaders(proc: ManagedProcess): void {
    if (persistentReadersStarted) return;
    persistentReadersStarted = true;

    const stdoutDecoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();

    // Stdout reader
    void (async () => {
      const reader = proc.stdout.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = stdoutDecoder.decode(value, { stream: true });
          onStdoutChunk?.(text);
        }
      } catch {
        // Stream read error (process crashed, fd closed) — treated as process exit
      } finally {
        reader.releaseLock();
      }
      // stdout closed or errored = process exited
      onProcessExit?.();
    })();

    // Stderr reader
    void (async () => {
      const reader = proc.stderr.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = stderrDecoder.decode(value, { stream: true });
          onStderrChunk?.(text);
        }
      } catch {
        // Stream read error (process crashed, fd closed) — no action needed
      } finally {
        reader.releaseLock();
      }
    })();
  }

  // ---------------------------------------------------------------------------
  // Single-shot mode
  // ---------------------------------------------------------------------------

  async function* runSingleShot(input: EngineInput): AsyncGenerator<EngineEvent, void, undefined> {
    if (running) {
      throw new Error("ExternalAdapter does not support concurrent single-shot runs");
    }
    running = true;
    const startTime = Date.now();

    try {
      const inputText = extractInputText(input);
      const spawnResult = spawnProcess(command, args, env, cwd);

      if (!spawnResult.ok) {
        const output: EngineOutput = {
          content: [{ kind: "text", text: spawnResult.error.message }],
          stopReason: "error",
          metrics: createZeroMetrics(Date.now() - startTime),
        };
        yield { kind: "done", output };
        return;
      }

      const proc = spawnResult.value;
      currentProcess = proc;

      // Write input to stdin, then close
      if (inputText.length > 0) {
        proc.stdin.write(TEXT_ENCODER.encode(inputText));
      }
      proc.stdin.end();

      const parser = parserFactory();
      const queue = createAsyncQueue<EngineEvent>();

      // Abort handling
      const abortController = new AbortController();
      const abortSignal = abortController.signal;

      if (input.signal !== undefined) {
        if (input.signal.aborted) {
          await killProcess(proc, shutdown);
          const output: EngineOutput = {
            content: [],
            stopReason: "interrupted",
            metrics: createZeroMetrics(Date.now() - startTime),
          };
          yield { kind: "done", output };
          return;
        }
        input.signal.addEventListener(
          "abort",
          () => {
            abortController.abort();
            void killProcess(proc, shutdown);
          },
          { once: true },
        );
      }

      // Timeout handling
      // let: timeout handle for cleanup
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          abortController.abort();
          void killProcess(proc, shutdown);
        }, timeoutMs);
      }

      // No-output watchdog: kills process if no output for noOutputTimeoutMs
      const watchdog = createWatchdog(noOutputTimeoutMs, () => {
        abortController.abort();
        void killProcess(proc, shutdown);
      });

      // Start reading stdout and stderr concurrently
      const stdoutDone = readStream(
        proc.stdout,
        (text) => {
          watchdog?.reset();
          outputHistory.push(text);
          trimHistory(outputHistory, DEFAULT_MAX_HISTORY_ENTRIES);
          const result = parser.parseStdout(text);
          for (const event of result.events) {
            queue.push(event);
          }
        },
        maxOutputBytes,
        abortSignal,
      );

      const stderrDone = readStream(
        proc.stderr,
        (text) => {
          watchdog?.reset();
          const events = parser.parseStderr(text);
          for (const event of events) {
            queue.push(event);
          }
        },
        maxOutputBytes,
        abortSignal,
      );

      // Wait for streams + process exit, then finalize
      void Promise.all([stdoutDone, stderrDone, proc.exited]).then(([, , exitCode]) => {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        watchdog?.clear();

        const flushed = parser.flush();
        for (const event of flushed) {
          queue.push(event);
        }

        // let: inferred from exit code and abort state
        let stopReason: EngineStopReason = "completed";
        if (abortSignal.aborted) {
          stopReason = input.signal?.aborted === true ? "interrupted" : "error";
        } else if (exitCode !== 0) {
          stopReason = "error";
        }

        const content: readonly ContentBlock[] = [];
        const output: EngineOutput = {
          content,
          stopReason,
          metrics: createZeroMetrics(Date.now() - startTime),
        };
        queue.push({ kind: "done", output });
        queue.end();
      });

      for await (const event of queue) {
        yield event;
      }
    } finally {
      running = false;
      currentProcess = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Long-lived mode
  // ---------------------------------------------------------------------------

  async function* runLongLived(input: EngineInput): AsyncGenerator<EngineEvent, void, undefined> {
    if (running) {
      throw new Error("ExternalAdapter does not support concurrent long-lived turns");
    }
    running = true;
    const startTime = Date.now();

    try {
      // Spawn on first call
      if (currentProcess === undefined) {
        const spawnResult = spawnProcess(command, args, env, cwd);
        if (!spawnResult.ok) {
          const output: EngineOutput = {
            content: [{ kind: "text", text: spawnResult.error.message }],
            stopReason: "error",
            metrics: createZeroMetrics(Date.now() - startTime),
          };
          yield { kind: "done", output };
          return;
        }
        currentProcess = spawnResult.value;
        persistentReadersStarted = false;

        // Detect unexpected exit
        void currentProcess.exited.then(() => {
          currentProcess = undefined;
          persistentReadersStarted = false;
        });
      }

      const proc = currentProcess;
      const inputText = extractInputText(input);
      const parser = parserFactory();
      const queue = createAsyncQueue<EngineEvent>();

      // let: flag to prevent double-ending the queue
      let queueEnded = false;
      // let: timeout handle — declared before finishTurn to avoid temporal dead zone
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      // No-output watchdog for this turn
      const watchdog = createWatchdog(noOutputTimeoutMs, () => {
        finishTurn("error");
      });

      function finishTurn(stopReason: EngineStopReason): void {
        if (queueEnded) return;
        queueEnded = true;
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        watchdog?.clear();

        // Detach handlers so persistent readers stop dispatching to this turn
        onStdoutChunk = undefined;
        onStderrChunk = undefined;
        onProcessExit = undefined;
        currentFinishTurn = undefined;

        const flushed = parser.flush();
        for (const event of flushed) {
          queue.push(event);
        }
        const output: EngineOutput = {
          content: [],
          stopReason,
          metrics: createZeroMetrics(Date.now() - startTime),
        };
        queue.push({ kind: "done", output });
        queue.end();
      }

      // Expose finishTurn for dispose()
      currentFinishTurn = finishTurn;

      // Abort signal handling
      if (input.signal !== undefined) {
        if (input.signal.aborted) {
          finishTurn("interrupted");
          return;
        }
        input.signal.addEventListener("abort", () => finishTurn("interrupted"), { once: true });
      }

      // Wire up dispatch handlers for this turn
      onStdoutChunk = (text: string) => {
        if (queueEnded) return;
        watchdog?.reset();
        outputHistory.push(text);
        trimHistory(outputHistory, DEFAULT_MAX_HISTORY_ENTRIES);
        const result = parser.parseStdout(text);
        for (const event of result.events) {
          queue.push(event);
        }
        if (result.turnComplete === true) {
          finishTurn("completed");
        }
      };

      onStderrChunk = (text: string) => {
        if (queueEnded) return;
        watchdog?.reset();
        const events = parser.parseStderr(text);
        for (const event of events) {
          queue.push(event);
        }
      };

      onProcessExit = () => {
        if (!queueEnded) {
          finishTurn("error");
          currentProcess = undefined;
          persistentReadersStarted = false;
        }
      };

      // Start persistent readers (only once per process)
      startPersistentReaders(proc);

      // Write input to stdin (do NOT close — process stays alive)
      if (inputText.length > 0) {
        proc.stdin.write(TEXT_ENCODER.encode(`${inputText}\n`));
      }

      // Timeout for this turn
      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          finishTurn("error");
        }, timeoutMs);
      }

      for await (const event of queue) {
        yield event;
      }
    } finally {
      running = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Adapter interface
  // ---------------------------------------------------------------------------

  return {
    engineId: ENGINE_ID,

    stream(input: EngineInput): AsyncIterable<EngineEvent> {
      if (disposed) {
        throw new Error("ExternalAdapter has been disposed");
      }
      if (mode === "long-lived") {
        return runLongLived(input);
      }
      return runSingleShot(input);
    },

    write(data: string): void {
      if (currentProcess === undefined) {
        throw new Error("No running process to write to");
      }
      currentProcess.stdin.write(TEXT_ENCODER.encode(data));
    },

    isRunning(): boolean {
      return currentProcess !== undefined;
    },

    async saveState(): Promise<EngineState> {
      return {
        engineId: ENGINE_ID,
        data: {
          command,
          args: [...args],
          cwd,
          outputHistory: [...outputHistory],
        } satisfies ExternalProcessState,
      };
    },

    async loadState(state: EngineState): Promise<void> {
      if (state.engineId !== ENGINE_ID) {
        throw new Error(`Cannot load state from engine "${state.engineId}" into "${ENGINE_ID}"`);
      }
      if (!isExternalProcessState(state.data)) {
        throw new Error("Invalid ExternalProcessState shape");
      }
      const loaded = [...state.data.outputHistory];
      // Enforce cap on loaded state to prevent untrusted snapshots from consuming unbounded memory
      outputHistory =
        loaded.length > DEFAULT_MAX_HISTORY_ENTRIES
          ? loaded.slice(loaded.length - DEFAULT_MAX_HISTORY_ENTRIES)
          : loaded;
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      // End current turn if one is active (unblocks pending queue consumers)
      currentFinishTurn?.("interrupted");
      // Clear remaining handlers
      onStdoutChunk = undefined;
      onStderrChunk = undefined;
      onProcessExit = undefined;
      currentFinishTurn = undefined;
      if (currentProcess !== undefined) {
        await killProcess(currentProcess, shutdown);
        currentProcess = undefined;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// No-output watchdog
// ---------------------------------------------------------------------------

/**
 * Creates a watchdog that fires `onTimeout` if `reset()` is not called
 * within `intervalMs`. Each `reset()` restarts the timer. `clear()` stops it.
 * Returns undefined if `intervalMs <= 0` (disabled).
 */
function createWatchdog(
  intervalMs: number,
  onTimeout: () => void,
): { readonly reset: () => void; readonly clear: () => void } | undefined {
  if (intervalMs <= 0) return undefined;
  // let: the pending timer handle, restarted on each reset()
  let handle: ReturnType<typeof setTimeout> | undefined = setTimeout(onTimeout, intervalMs);
  return {
    reset(): void {
      if (handle !== undefined) clearTimeout(handle);
      handle = setTimeout(onTimeout, intervalMs);
    },
    clear(): void {
      if (handle !== undefined) {
        clearTimeout(handle);
        handle = undefined;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Trim output history to prevent unbounded growth in long-lived mode.
 * Drops the oldest entries when the cap is exceeded.
 */
function trimHistory(history: string[], maxEntries: number): void {
  if (history.length > maxEntries) {
    history.splice(0, history.length - maxEntries);
  }
}

function createZeroMetrics(durationMs: number): EngineMetrics {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    turns: 1,
    durationMs,
  };
}

function isExternalProcessState(value: unknown): value is ExternalProcessState {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.command === "string" &&
    Array.isArray(record.args) &&
    record.args.every((a: unknown) => typeof a === "string") &&
    typeof record.cwd === "string" &&
    Array.isArray(record.outputHistory) &&
    record.outputHistory.every((h: unknown) => typeof h === "string")
  );
}
