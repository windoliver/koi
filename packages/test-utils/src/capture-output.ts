/**
 * Output capture helper for tests.
 *
 * Intercepts process.stdout/stderr writes during test execution.
 */

export interface CapturedOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly restore: () => void;
}

/**
 * Captures writes to process.stdout and process.stderr.
 *
 * Call `restore()` when done to re-attach original streams.
 * Best used in a try/finally block or beforeEach/afterEach.
 */
export function captureOutput(): CapturedOutput {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  };

  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderrChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  };

  return {
    get stdout() {
      return stdoutChunks.join("");
    },
    get stderr() {
      return stderrChunks.join("");
    },
    restore() {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    },
  };
}
