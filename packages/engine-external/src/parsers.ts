/**
 * Output parsers for external process stdout/stderr.
 *
 * Each factory returns a fresh OutputParser (stateful per stream() call).
 */

import type { EngineEvent } from "@koi/core";
import type { OutputParseResult, OutputParser, OutputParserFactory } from "./types.js";

// ---------------------------------------------------------------------------
// Text delta parser (default)
// ---------------------------------------------------------------------------

/**
 * Simplest parser: each stdout chunk becomes a text_delta event,
 * stderr becomes a custom(stderr) event. Never signals turnComplete.
 */
export function createTextDeltaParser(): OutputParserFactory {
  return (): OutputParser => ({
    parseStdout(chunk: string): OutputParseResult {
      return {
        events: [{ kind: "text_delta", delta: chunk }],
        turnComplete: false,
      };
    },

    parseStderr(chunk: string): readonly EngineEvent[] {
      return [{ kind: "custom", type: "stderr", data: chunk }];
    },

    flush(): readonly EngineEvent[] {
      return [];
    },
  });
}

// ---------------------------------------------------------------------------
// JSON lines parser
// ---------------------------------------------------------------------------

/**
 * Line-buffered JSON parser. Each complete line on stdout is parsed as JSON:
 * - If it's a valid EngineEvent shape, emit it directly
 * - If the parsed object has `kind: "done"`, set `turnComplete: true`
 * - Invalid JSON falls back to text_delta
 *
 * stderr always maps to custom(stderr) events.
 * flush() emits any remaining partial line as text_delta.
 */
export function createJsonLinesParser(): OutputParserFactory {
  return (): OutputParser => {
    // let: partial line buffer across chunks
    let stdoutBuffer = "";

    return {
      parseStdout(chunk: string): OutputParseResult {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        // Last element is incomplete (no trailing newline) — keep it buffered
        stdoutBuffer = lines.pop() ?? "";

        const events: EngineEvent[] = [];
        // let: may be set by a parsed done event
        let turnComplete = false;

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;

          try {
            const parsed: unknown = JSON.parse(trimmed);
            if (isEngineEventShape(parsed)) {
              if (parsed.kind === "done") {
                // Do NOT forward external done events — the adapter constructs its own.
                // Signal turnComplete so the adapter knows this response is finished.
                turnComplete = true;
              } else {
                events.push(parsed);
              }
            } else {
              events.push({ kind: "text_delta", delta: `${line}\n` });
            }
          } catch {
            events.push({ kind: "text_delta", delta: `${line}\n` });
          }
        }

        return { events, turnComplete };
      },

      parseStderr(chunk: string): readonly EngineEvent[] {
        return [{ kind: "custom", type: "stderr", data: chunk }];
      },

      flush(): readonly EngineEvent[] {
        if (stdoutBuffer.length === 0) return [];
        const remaining = stdoutBuffer;
        stdoutBuffer = "";
        return [{ kind: "text_delta", delta: remaining }];
      },
    };
  };
}

// Must stay in sync with EngineEvent kinds in @koi/core/src/engine.ts
const VALID_ENGINE_EVENT_KINDS: ReadonlySet<string> = new Set([
  "text_delta",
  "tool_call_start",
  "tool_call_delta",
  "tool_call_end",
  "turn_start",
  "turn_end",
  "done",
  "custom",
]);

/**
 * Minimal check: does the parsed value look like an EngineEvent?
 * Must have a `kind` string property matching known event kinds.
 */
function isEngineEventShape(value: unknown): value is EngineEvent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== "string") return false;
  return VALID_ENGINE_EVENT_KINDS.has(record.kind);
}

// ---------------------------------------------------------------------------
// Line parser (callback-driven)
// ---------------------------------------------------------------------------

/**
 * Generic line-buffered parser with a user-provided mapping function.
 * Each complete line is passed to `mapLine`; returning `undefined` skips it.
 */
export function createLineParser(
  mapLine: (line: string, source: "stdout" | "stderr") => OutputParseResult | undefined,
): OutputParserFactory {
  return (): OutputParser => {
    // let: partial line buffers
    let stdoutBuffer = "";
    let stderrBuffer = "";

    return {
      parseStdout(chunk: string): OutputParseResult {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";

        const events: EngineEvent[] = [];
        // let: may be set by mapLine result
        let turnComplete = false;

        for (const line of lines) {
          const result = mapLine(line, "stdout");
          if (result !== undefined) {
            events.push(...result.events);
            if (result.turnComplete === true) {
              turnComplete = true;
            }
          }
        }

        return { events, turnComplete };
      },

      parseStderr(chunk: string): readonly EngineEvent[] {
        stderrBuffer += chunk;
        const lines = stderrBuffer.split("\n");
        stderrBuffer = lines.pop() ?? "";

        const events: EngineEvent[] = [];
        for (const line of lines) {
          const result = mapLine(line, "stderr");
          if (result !== undefined) {
            events.push(...result.events);
          }
        }
        return events;
      },

      flush(): readonly EngineEvent[] {
        const events: EngineEvent[] = [];
        if (stdoutBuffer.length > 0) {
          const result = mapLine(stdoutBuffer, "stdout");
          if (result !== undefined) {
            events.push(...result.events);
          }
          stdoutBuffer = "";
        }
        if (stderrBuffer.length > 0) {
          const result = mapLine(stderrBuffer, "stderr");
          if (result !== undefined) {
            events.push(...result.events);
          }
          stderrBuffer = "";
        }
        return events;
      },
    };
  };
}
