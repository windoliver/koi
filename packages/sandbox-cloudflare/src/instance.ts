/**
 * Cloudflare SandboxInstance implementation.
 */

import type { SandboxAdapterResult, SandboxExecOptions, SandboxInstance } from "@koi/core";
import { createDestroyGuard, createOutputAccumulator } from "@koi/sandbox-cloud-base";
import { classifyCloudflareError } from "./classify.js";
import type { CfSdkSandbox } from "./types.js";

const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Create a SandboxInstance backed by a Cloudflare SDK sandbox. */
export function createCloudflareInstance(sdk: CfSdkSandbox): SandboxInstance {
  const guard = createDestroyGuard("cloudflare");

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
        const classified = classifyCloudflareError(e, durationMs);

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
      await sdk.close();
    },
  };
}
