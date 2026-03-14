/**
 * Structured CLI output with consistent prefixes, colors, and spinner coordination.
 *
 * All status output goes to stderr (preserving stdout for agent responses).
 * When a spinner is active on a TTY, it is cleared before any log line
 * is written and resumed afterward. On non-TTY, writes go through directly
 * without pause/resume (no spinner animation to interrupt).
 */

import { createColors } from "./colors.js";
import { isColorEnabled } from "./detect.js";
import { createSafeReplacer } from "./json-replacer.js";
import { createSpinner, type Spinner } from "./spinner.js";

export interface CliOutput {
  /** Informational message (no prefix, dimmed). */
  readonly info: (text: string) => void;
  /** Warning message (yellow "warn:" prefix). */
  readonly warn: (text: string) => void;
  /** Error message (red "error:" prefix). */
  readonly error: (text: string, hint?: string) => void;
  /** Success message (green checkmark prefix). */
  readonly success: (text: string) => void;
  /** Hint message (dimmed "hint:" prefix). */
  readonly hint: (text: string) => void;
  /** Debug message (gray, only shown when verbose). */
  readonly debug: (text: string) => void;
  /** Access the underlying spinner for phase progress. */
  readonly spinner: Spinner;
  /** Whether the output stream is a TTY. */
  readonly isTTY: boolean;
}

export interface CliOutputOptions {
  readonly stream?: NodeJS.WritableStream;
  readonly verbose?: boolean;
  /** Log format: "text" (default) for human-readable, "json" for NDJSON. */
  readonly logFormat?: "text" | "json" | undefined;
}

export function createCliOutput(options?: CliOutputOptions): CliOutput {
  const stream = options?.stream ?? process.stderr;
  const verbose = options?.verbose ?? false;
  const logFormat = options?.logFormat ?? "text";
  const isTTY = "isTTY" in stream && (stream as NodeJS.WriteStream).isTTY === true;
  const colorEnabled = isColorEnabled(isTTY ? (stream as NodeJS.WriteStream) : undefined);
  const c = createColors(colorEnabled);
  const spinner = createSpinner(stream);

  // Track managed spinner state so we can pause/resume around log lines
  let spinnerText: string | undefined;

  const managedSpinner: Spinner = {
    start(text: string): void {
      spinnerText = text;
      // JSON mode skips spinner coordination (no TTY formatting needed)
      if (logFormat !== "json") spinner.start(text);
    },
    stop(finalText?: string): void {
      spinnerText = undefined;
      if (logFormat !== "json") spinner.stop(finalText);
    },
    update(text: string): void {
      spinnerText = text;
      if (logFormat !== "json") spinner.update(text);
    },
    isActive(): boolean {
      return spinnerText !== undefined;
    },
  };

  /**
   * Write a JSON log line (NDJSON) to the stream.
   */
  function writeJson(
    level: string,
    msg: string,
    extra?: Readonly<Record<string, string>>,
  ): void {
    const entry: Record<string, string> = {
      level,
      msg,
      ts: new Date().toISOString(),
      ...extra,
    };
    stream.write(`${JSON.stringify(entry, createSafeReplacer())}\n`);
  }

  /**
   * Write a log line to the stream. On TTY with active spinner, clears the
   * spinner line first and resumes after. On non-TTY, writes directly
   * without touching the spinner (avoids duplicate static lines).
   */
  function write(line: string): void {
    if (isTTY && spinnerText !== undefined) {
      spinner.stop();
      stream.write(`${line}\n`);
      spinner.start(spinnerText);
    } else {
      stream.write(`${line}\n`);
    }
  }

  if (logFormat === "json") {
    return {
      info(text: string): void {
        writeJson("info", text);
      },
      warn(text: string): void {
        writeJson("warn", text);
      },
      error(text: string, hint?: string): void {
        writeJson("error", text, hint !== undefined ? { hint } : undefined);
      },
      success(text: string): void {
        writeJson("info", text);
      },
      hint(text: string): void {
        writeJson("info", text);
      },
      debug(text: string): void {
        if (verbose) writeJson("debug", text);
      },
      spinner: managedSpinner,
      isTTY,
    };
  }

  return {
    info(text: string): void {
      write(c.dim(text));
    },
    warn(text: string): void {
      write(`${c.yellow("warn:")} ${text}`);
    },
    error(text: string, hint?: string): void {
      write(`${c.red("error:")} ${text}`);
      if (hint !== undefined) {
        write(`${c.dim("hint:")} ${hint}`);
      }
    },
    success(text: string): void {
      write(`${c.green("\u2713")} ${text}`);
    },
    hint(text: string): void {
      write(`${c.dim("hint:")} ${text}`);
    },
    debug(text: string): void {
      if (verbose) write(c.gray(text));
    },
    spinner: managedSpinner,
    isTTY,
  };
}
