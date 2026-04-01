/**
 * PTY mode generator — wraps interactive CLI agents via pseudo-terminal.
 *
 * Uses Bun.Terminal (native PTY, zero deps) to spawn processes in a real TTY.
 * Turn completion is detected via hybrid idle threshold + optional prompt regex.
 */

import type { EngineEvent, EngineInput, EngineOutput } from "@koi/core";
import { stripAnsi } from "./ansi.js";
import type { IdleDetector } from "./idle-detector.js";
import { createIdleDetector } from "./idle-detector.js";
import { killProcess, spawnPtyProcess } from "./process-manager.js";
import { createZeroMetrics, extractInputText, trimHistory } from "./shared-helpers.js";
import { createTurnContext } from "./turn-context.js";
import type { OutputParserFactory, PtyConfig, PtyProcess, ShutdownConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_IDLE_THRESHOLD_MS = 30_000 as const;
const DEFAULT_COLS = 120 as const;
const DEFAULT_ROWS = 40 as const;
const DEFAULT_MAX_HISTORY_ENTRIES = 10_000 as const;

// ---------------------------------------------------------------------------
// Resolved config
// ---------------------------------------------------------------------------

export interface ResolvedPtyConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly parserFactory: OutputParserFactory;
  readonly timeoutMs: number;
  readonly noOutputTimeoutMs: number;
  readonly shutdown?: ShutdownConfig | undefined;
  readonly idleThresholdMs: number;
  readonly ansiStrip: boolean;
  readonly cols: number;
  readonly rows: number;
  readonly promptPattern?: RegExp | undefined;
}

/** Mutable shared state passed from the adapter factory closure. */
export interface PtySharedState {
  outputHistory: string[];
  currentProcess: PtyProcess | undefined;
  disposed: boolean;
}

// ---------------------------------------------------------------------------
// Resolve PTY config from raw adapter config
// ---------------------------------------------------------------------------

export function resolvePtyConfig(
  command: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
  parserFactory: OutputParserFactory,
  timeoutMs: number,
  noOutputTimeoutMs: number,
  shutdown: ShutdownConfig | undefined,
  pty: PtyConfig | undefined,
): ResolvedPtyConfig {
  const promptPatternStr = pty?.promptPattern;
  // let: compiled regex — undefined if no pattern provided
  let promptPattern: RegExp | undefined;
  if (promptPatternStr !== undefined) {
    promptPattern = new RegExp(promptPatternStr);
  }

  return {
    command,
    args,
    cwd,
    env,
    parserFactory,
    timeoutMs,
    noOutputTimeoutMs,
    shutdown,
    idleThresholdMs: pty?.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS,
    ansiStrip: pty?.ansiStrip ?? true,
    cols: pty?.cols ?? DEFAULT_COLS,
    rows: pty?.rows ?? DEFAULT_ROWS,
    promptPattern,
  };
}

// ---------------------------------------------------------------------------
// PTY generator
// ---------------------------------------------------------------------------

export async function* runPty(
  config: ResolvedPtyConfig,
  input: EngineInput,
  shared: PtySharedState,
): AsyncGenerator<EngineEvent, void, undefined> {
  const startTime = Date.now();
  const inputText = extractInputText(input);
  const parser = config.parserFactory();

  // Spawn PTY process
  const decoder = new TextDecoder();

  // let: idle detector — initialized after process spawn
  let idleDetector: IdleDetector | undefined;

  // Create the turn context first (handles abort/timeout)
  const turn = createTurnContext({
    timeoutMs: config.timeoutMs,
    noOutputTimeoutMs: 0, // We use idle detector instead of watchdog
    signal: input.signal,
    parser,
    startTime,
    onFinished() {
      idleDetector?.dispose();
    },
  });

  if (turn.isFinished()) {
    for await (const event of turn.queue) {
      yield event;
    }
    return;
  }

  // Wire PTY data callback — will be connected to the PTY onData
  function handlePtyData(data: Uint8Array): void {
    if (turn.isFinished()) return;

    const raw = decoder.decode(data, { stream: true });
    const text = config.ansiStrip ? stripAnsi(raw) : raw;

    // Feed to idle detector
    idleDetector?.recordOutput(text);

    // Feed to parser → queue
    const result = parser.parseStdout(text);
    for (const event of result.events) {
      turn.queue.push(event);
    }

    // Store in history (trimHistory returns a new array when trimming is needed)
    shared.outputHistory = trimHistory(
      [...shared.outputHistory, text],
      DEFAULT_MAX_HISTORY_ENTRIES,
    ) as string[];

    if (result.turnComplete === true) {
      turn.finish("completed");
    }
  }

  // Spawn PTY
  const spawnResult = spawnPtyProcess(
    config.command,
    config.args,
    config.env,
    config.cwd,
    { cols: config.cols, rows: config.rows },
    handlePtyData,
  );

  if (!spawnResult.ok) {
    const output: EngineOutput = {
      content: [{ kind: "text", text: spawnResult.error.message }],
      stopReason: "error",
      metrics: createZeroMetrics(Date.now() - startTime),
    };
    turn.queue.push({ kind: "done", output });
    turn.queue.end();
    for await (const event of turn.queue) {
      yield event;
    }
    return;
  }

  const proc = spawnResult.value;
  shared.currentProcess = proc;

  // Create idle detector
  idleDetector = createIdleDetector({
    idleThresholdMs: config.idleThresholdMs,
    promptPattern: config.promptPattern,
    onIdle() {
      turn.finish("completed");
    },
  });

  // Detect process exit
  void proc.exited.then(() => {
    if (!turn.isFinished()) {
      turn.finish("completed");
    }
    shared.currentProcess = undefined;
  });

  // Wire abort to kill process.
  // Register listener first, then re-check — closes the race window where
  // the signal fires between the spawn and addEventListener.
  if (input.signal !== undefined) {
    input.signal.addEventListener(
      "abort",
      () => {
        void killProcess(proc, config.shutdown);
      },
      { once: true },
    );
    // If signal was already aborted, the listener won't fire — kill now
    if (input.signal.aborted) {
      void killProcess(proc, config.shutdown);
    }
  }

  // Write input to PTY
  if (inputText.length > 0) {
    proc.terminal.write(`${inputText}\n`);
  }

  for await (const event of turn.queue) {
    yield event;
  }
}
