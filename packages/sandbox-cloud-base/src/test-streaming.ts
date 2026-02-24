/**
 * Shared streaming test helpers — reusable assertions for cloud sandbox adapters.
 *
 * Provides utilities to verify streaming callbacks (onStdout/onStderr)
 * work correctly across all cloud adapter implementations.
 */

import type { SandboxExecOptions } from "@koi/core";

/** Collected chunks from streaming callbacks. */
export interface StreamCollector {
  readonly stdoutChunks: readonly string[];
  readonly stderrChunks: readonly string[];
  readonly options: SandboxExecOptions;
}

/**
 * Create a stream collector that captures onStdout/onStderr callbacks.
 *
 * Returns an object with the collected chunks and SandboxExecOptions
 * pre-configured with the streaming callbacks.
 */
export function createStreamCollector(
  baseOptions?: Omit<SandboxExecOptions, "onStdout" | "onStderr">,
): StreamCollector {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const options: SandboxExecOptions = {
    ...baseOptions,
    onStdout: (chunk: string) => {
      stdoutChunks.push(chunk);
    },
    onStderr: (chunk: string) => {
      stderrChunks.push(chunk);
    },
  };

  return {
    get stdoutChunks() {
      return [...stdoutChunks];
    },
    get stderrChunks() {
      return [...stderrChunks];
    },
    options,
  };
}
