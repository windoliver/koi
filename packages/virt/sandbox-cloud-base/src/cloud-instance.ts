/**
 * Shared cloud sandbox instance factory.
 *
 * All cloud adapters (E2B, Cloudflare, Daytona, Vercel) share the same
 * exec/readFile/writeFile/destroy pattern. This module extracts that common
 * logic so each adapter only provides: SDK handle, error classifier, destroy fn.
 */

import type {
  SandboxAdapterResult,
  SandboxExecOptions,
  SandboxInstance,
  SandboxProcessHandle,
  SandboxSpawnOptions,
} from "@koi/core";
import type { ClassifiedError } from "./classify-error.js";
import { createDestroyGuard } from "./guard.js";
import { shellJoin } from "./shell-escape.js";
import { createOutputAccumulator, DEFAULT_MAX_OUTPUT_BYTES } from "./truncate.js";

// ---------------------------------------------------------------------------
// Cloud SDK shape — minimal interface shared by all cloud providers
// ---------------------------------------------------------------------------

/** Handle returned by cloud SDK background process spawn. */
export interface CloudSdkProcessHandle {
  readonly pid: number;
  /** Send data to the process's stdin. */
  readonly sendStdin: (data: string) => void | Promise<void>;
  /** Close the process's stdin (EOF). */
  readonly closeStdin: () => void;
  /** Resolves with exit code when the process exits. */
  readonly exited: Promise<number>;
  /** Kill the process. */
  readonly kill: (signal?: number) => void;
}

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
    /**
     * Spawn a long-lived background process with streaming I/O.
     *
     * Optional — adapters that only support run-to-completion omit this.
     * When provided, SandboxInstance.spawn() is available.
     */
    readonly spawn?: (
      cmd: string,
      opts?: {
        readonly cwd?: string;
        readonly envs?: Record<string, string>;
        readonly onStdout?: (data: string) => void;
        readonly onStderr?: (data: string) => void;
      },
    ) => Promise<CloudSdkProcessHandle>;
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

      const fullCmd = shellJoin(command, args);
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

    // Only expose spawn() if the SDK supports background processes
    ...(sdk.commands.spawn !== undefined
      ? {
          spawn: async (
            command: string,
            args: readonly string[],
            options?: SandboxSpawnOptions,
          ): Promise<SandboxProcessHandle> => {
            guard.check("spawn");

            if (options?.signal?.aborted) {
              throw new Error("Spawn aborted before start");
            }

            const fullCmd = shellJoin(command, args);
            const encoder = new TextEncoder();
            const decoder = new TextDecoder();

            // Bridge cloud SDK callbacks to ReadableStreams
            let stdoutCtrl!: ReadableStreamDefaultController<Uint8Array>;
            let stderrCtrl!: ReadableStreamDefaultController<Uint8Array>;

            const stdout = new ReadableStream<Uint8Array>({
              start(controller) {
                stdoutCtrl = controller;
              },
            });
            const stderr = new ReadableStream<Uint8Array>({
              start(controller) {
                stderrCtrl = controller;
              },
            });

            const sdkOpts: {
              cwd?: string;
              envs?: Record<string, string>;
              onStdout: (data: string) => void;
              onStderr: (data: string) => void;
            } = {
              onStdout: (data: string) => {
                stdoutCtrl.enqueue(encoder.encode(data));
              },
              onStderr: (data: string) => {
                stderrCtrl.enqueue(encoder.encode(data));
              },
            };

            if (options?.cwd !== undefined) sdkOpts.cwd = options.cwd;
            if (options?.env !== undefined) sdkOpts.envs = { ...options.env };

            const spawnFn = sdk.commands.spawn;
            if (spawnFn === undefined) {
              throw new Error("spawn is not available on SDK");
            }
            const handle = await spawnFn(fullCmd, sdkOpts);

            // Close streams when process exits
            handle.exited.then(
              () => {
                stdoutCtrl.close();
                stderrCtrl.close();
              },
              () => {
                stdoutCtrl.close();
                stderrCtrl.close();
              },
            );

            // Wire abort signal
            if (options?.signal !== undefined) {
              options.signal.addEventListener(
                "abort",
                () => {
                  handle.kill(9);
                },
                { once: true },
              );
            }

            return {
              pid: handle.pid,
              stdin: {
                write: (data: string | Uint8Array): void | Promise<void> => {
                  const text = typeof data === "string" ? data : decoder.decode(data);
                  return handle.sendStdin(text);
                },
                end: () => handle.closeStdin(),
              },
              stdout,
              stderr,
              exited: handle.exited,
              kill: handle.kill,
            };
          },
        }
      : {}),

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
