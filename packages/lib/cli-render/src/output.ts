/**
 * Structured CLI output with consistent prefixes, colors, and spinner coordination.
 *
 * All status output goes to stderr (preserving stdout for agent responses).
 * When a spinner is active, it is cleared before any log line is written
 * and resumed afterward.
 */

import { createColors } from "./colors.js";
import { isColorEnabled } from "./detect.js";
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
}

export function createCliOutput(options?: CliOutputOptions): CliOutput {
  const stream = options?.stream ?? process.stderr;
  const verbose = options?.verbose ?? false;
  const isTTY = "isTTY" in stream && (stream as NodeJS.WriteStream).isTTY === true;
  const colorEnabled = isColorEnabled(isTTY ? (stream as NodeJS.WriteStream) : undefined);
  const c = createColors(colorEnabled);
  const spinner = createSpinner(stream);

  // Track spinner state so we can pause/resume around log lines
  let spinnerText: string | undefined;

  const managedSpinner: Spinner = {
    start(text: string): void {
      spinnerText = text;
      spinner.start(text);
    },
    stop(finalText?: string): void {
      spinnerText = undefined;
      spinner.stop(finalText);
    },
    update(text: string): void {
      spinnerText = text;
      spinner.update(text);
    },
  };

  /**
   * Write a log line to the stream. If the spinner is active, pause it
   * first and resume after the line is written — prevents garbled output.
   */
  function write(line: string): void {
    if (spinnerText !== undefined) {
      spinner.stop();
      stream.write(`${line}\n`);
      spinner.start(spinnerText);
    } else {
      stream.write(`${line}\n`);
    }
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
