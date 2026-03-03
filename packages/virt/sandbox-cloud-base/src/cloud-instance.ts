/**
 * Shared cloud sandbox instance factory.
 *
 * All cloud adapters (E2B, Cloudflare, Daytona, Vercel) share the same
 * exec/readFile/writeFile/destroy pattern. This module extracts that common
 * logic so each adapter only provides: SDK handle, error classifier, destroy fn.
 */

import type { SandboxAdapterResult, SandboxExecOptions, SandboxInstance } from "@koi/core";
import type { ClassifiedError } from "./classify-error.js";
import { createDestroyGuard } from "./guard.js";
import { createOutputAccumulator, DEFAULT_MAX_OUTPUT_BYTES } from "./truncate.js";

// ---------------------------------------------------------------------------
// Cloud SDK shape — minimal interface shared by all cloud providers
// ---------------------------------------------------------------------------

/** Minimal SDK shape shared across E2B, Cloudflare, Daytona, and Vercel. */
export interface CloudSdkSandbox {
  readonly commands: {
    readonly run: (
      cmd: string,
      opts?: {
        readonly cwd?: string;
        readonly envs?: Record<string, string>;
        readonly timeoutMs?: number;
        readonly onStdout?: (data: string) => void;
        readonly onStderr?: (data: string) => void;
      },
    ) => Promise<{
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }>;
  };
  readonly files: {
    readonly read: (path: string) => Promise<string>;
    readonly write: (path: string, content: string) => Promise<void>;
  };
}

// ---------------------------------------------------------------------------
// Factory config
// ---------------------------------------------------------------------------

export interface CloudInstanceConfig {
  /** The cloud SDK sandbox handle. */
  readonly sdk: CloudSdkSandbox;
  /** Provider-specific error classifier. */
  readonly classifyError: (error: unknown, durationMs: number) => ClassifiedError;
  /** Provider-specific destroy/teardown function. */
  readonly destroy: () => Promise<void>;
  /** Adapter name for error messages (e.g., "e2b", "vercel"). */
  readonly name: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a SandboxInstance backed by a cloud SDK sandbox. */
export function createCloudInstance(config: CloudInstanceConfig): SandboxInstance {
  const { sdk, classifyError, destroy, name } = config;
  const guard = createDestroyGuard(name);

  return {
    exec: async (
      command: string,
      args: readonly string[],
      options?: SandboxExecOptions,
    ): Promise<SandboxAdapterResult> => {
      guard.check("exec");

      const fullCmd = args.length > 0 ? `${command} ${args.join(" ")}` : command;
      const startTime = performance.now();
      const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const stdoutAcc = createOutputAccumulator(maxOutputBytes);
      const stderrAcc = createOutputAccumulator(maxOutputBytes);

      try {
        const sdkOpts: {
          cwd?: string;
          envs?: Record<string, string>;
          timeoutMs?: number;
          onStdout?: (data: string) => void;
          onStderr?: (data: string) => void;
        } = {};

        if (options?.cwd !== undefined) sdkOpts.cwd = options.cwd;
        if (options?.env !== undefined) sdkOpts.envs = { ...options.env };
        if (options?.timeoutMs !== undefined) sdkOpts.timeoutMs = options.timeoutMs;

        sdkOpts.onStdout = (data: string) => {
          stdoutAcc.append(data);
          options?.onStdout?.(data);
        };
        sdkOpts.onStderr = (data: string) => {
          stderrAcc.append(data);
          options?.onStderr?.(data);
        };

        const result = await sdk.commands.run(fullCmd, sdkOpts);
        const durationMs = performance.now() - startTime;

        const stdoutResult = stdoutAcc.result();
        const stderrResult = stderrAcc.result();
        const truncated = stdoutResult.truncated || stderrResult.truncated;
        const stdout = stdoutResult.output || result.stdout;
        const stderr = stderrResult.output || result.stderr;

        return {
          exitCode: result.exitCode,
          stdout,
          stderr,
          durationMs,
          timedOut: false,
          oomKilled: false,
          ...(truncated ? { truncated } : {}),
        };
      } catch (e: unknown) {
        const durationMs = performance.now() - startTime;
        const classified = classifyError(e, durationMs);

        return {
          exitCode: 1,
          stdout: "",
          stderr: classified.message,
          durationMs,
          timedOut: classified.code === "TIMEOUT",
          oomKilled: classified.code === "OOM",
        };
      }
    },

    readFile: async (path: string): Promise<Uint8Array> => {
      guard.check("readFile");
      const content = await sdk.files.read(path);
      return new TextEncoder().encode(content);
    },

    writeFile: async (path: string, content: Uint8Array): Promise<void> => {
      guard.check("writeFile");
      const text = new TextDecoder().decode(content);
      await sdk.files.write(path, text);
    },

    destroy: async (): Promise<void> => {
      guard.markDestroyed();
      await destroy();
    },
  };
}
