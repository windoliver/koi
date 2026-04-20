import type { PatternMatch, TaskItemId } from "@koi/core";
import type { CompiledPattern } from "./compile.js";

const LINE_CAP_BYTES = 16 * 1024;

/** Per-stream line-buffered matcher. Stdout and stderr have independent buffers. */
export interface LineBufferedMatcher {
  readonly writeStdout: (taskId: TaskItemId, chunk: string) => void;
  readonly writeStderr: (taskId: TaskItemId, chunk: string) => void;
  /** Scan any trailing partial line on natural process exit. */
  readonly flush: (taskId: TaskItemId) => void;
  /** Dispose; subsequent writes are ignored. */
  readonly cancel: () => void;
}

interface StreamState {
  buffer: string;
  lineNumber: number;
  overflowEmitted: boolean;
  /** True while the current logical line has exceeded LINE_CAP_BYTES — suppress
   *  further matches until the next real newline resets this flag. */
  overflowMode: boolean;
}

export function createLineBufferedMatcher(
  compiled: readonly CompiledPattern[],
  onMatch: (match: PatternMatch) => void,
  onMatchWithLine?: (
    match: PatternMatch,
    line: string,
    matchStart: number,
    matchEnd: number,
  ) => void,
): LineBufferedMatcher {
  let cancelled = false;
  const stdout: StreamState = {
    buffer: "",
    lineNumber: 0,
    overflowEmitted: false,
    overflowMode: false,
  };
  const stderr: StreamState = {
    buffer: "",
    lineNumber: 0,
    overflowEmitted: false,
    overflowMode: false,
  };

  function scanLine(
    taskId: TaskItemId,
    stream: "stdout" | "stderr",
    line: string,
    lineNumber: number,
  ): void {
    for (const cp of compiled) {
      let matchStart = -1;
      let matchEnd = -1;
      try {
        if (onMatchWithLine !== undefined && cp.re.exec !== undefined) {
          const execResult = cp.re.exec(line);
          if (execResult === null) continue;
          const matchedText = execResult[0];
          if (matchedText === undefined) continue;
          matchStart = execResult.index;
          matchEnd = matchStart + matchedText.length;
        } else {
          if (!cp.re.test(line)) continue;
        }
      } catch {
        // Scanner errors on this pattern: skip this pattern on this line.
        continue;
      }
      const match: PatternMatch = {
        taskId,
        event: cp.event,
        stream,
        lineNumber,
        timestamp: Date.now(),
      };
      try {
        onMatch(match);
      } catch {
        // Consumer errors must not break other patterns or the decode loop.
      }
      if (onMatchWithLine !== undefined && matchStart >= 0) {
        try {
          onMatchWithLine(match, line, matchStart, matchEnd);
        } catch {
          // Consumer errors must not break the dispatch loop.
        }
      }
    }
  }

  function emitOverflow(taskId: TaskItemId, stream: "stdout" | "stderr", state: StreamState): void {
    if (state.overflowEmitted) return;
    state.overflowEmitted = true;
    try {
      onMatch({
        taskId,
        event: "__watch_overflow__",
        stream,
        lineNumber: state.lineNumber + 1,
        timestamp: Date.now(),
      });
    } catch {
      // Swallow — overflow is a best-effort signal.
    }
  }

  function processStream(
    taskId: TaskItemId,
    stream: "stdout" | "stderr",
    state: StreamState,
    chunk: string,
  ): void {
    if (cancelled) return;
    state.buffer += chunk;
    let newlineIdx = state.buffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const rawLine = state.buffer.slice(0, newlineIdx);
      state.buffer = state.buffer.slice(newlineIdx + 1);
      if (!state.overflowMode) {
        state.lineNumber += 1;
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        scanLine(taskId, stream, line, state.lineNumber);
      }
      // Reset overflow mode and guard on every real newline — next logical line starts fresh.
      state.overflowMode = false;
      state.overflowEmitted = false;
      newlineIdx = state.buffer.indexOf("\n");
    }
    // Oversized partial line — signal once, drop buffer, suppress further matches for this logical line.
    if (!state.overflowMode && state.buffer.length > LINE_CAP_BYTES) {
      emitOverflow(taskId, stream, state);
      state.overflowMode = true;
      state.buffer = "";
    }
  }

  return {
    writeStdout: (taskId, chunk) => {
      processStream(taskId, "stdout", stdout, chunk);
    },
    writeStderr: (taskId, chunk) => {
      processStream(taskId, "stderr", stderr, chunk);
    },
    flush: (taskId) => {
      if (cancelled) return;
      for (const [stream, state] of [
        ["stdout", stdout],
        ["stderr", stderr],
      ] as const) {
        if (state.buffer.length > 0 && !state.overflowMode) {
          state.lineNumber += 1;
          scanLine(taskId, stream, state.buffer, state.lineNumber);
        }
        state.buffer = "";
        state.overflowMode = false;
      }
    },
    cancel: () => {
      cancelled = true;
      stdout.buffer = "";
      stderr.buffer = "";
    },
  };
}
