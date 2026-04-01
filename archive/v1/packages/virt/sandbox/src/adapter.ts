/**
 * OS-level SandboxAdapter implementation.
 *
 * Wraps the stateless execute()/spawn() APIs into the stateful
 * SandboxAdapter/SandboxInstance contract from @koi/core.
 *
 * For OS-level sandboxing there is no persistent VM — each exec() call
 * creates a new sandboxed process. readFile/writeFile operate on the
 * host filesystem (the OS sandbox restricts what the process can access).
 */

import type {
  KoiError,
  Result,
  SandboxAdapter,
  SandboxAdapterResult,
  SandboxExecOptions,
  SandboxInstance,
  SandboxProcessHandle,
  SandboxProfile,
  SandboxSpawnOptions,
} from "@koi/core";
import type { ExecuteOptions } from "./execute.js";
import { execute } from "./execute.js";
import type { SandboxProcess } from "./spawn.js";
import { spawn } from "./spawn.js";

/**
 * Create an OS-level SandboxAdapter.
 *
 * The returned adapter uses macOS Seatbelt or Linux bubblewrap
 * depending on the current platform.
 */
export function createOsAdapter(): SandboxAdapter {
  return {
    name: "os",
    create: async (profile: SandboxProfile): Promise<SandboxInstance> => {
      return createInstance(profile);
    },
  };
}

function toExecuteOptions(options?: SandboxExecOptions): ExecuteOptions | undefined {
  if (options === undefined) return undefined;
  // Build options conditionally to satisfy exactOptionalPropertyTypes
  const result: {
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    stdin?: string;
    timeoutMs?: number;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    maxOutputBytes?: number;
    signal?: AbortSignal;
  } = {};
  if (options.cwd !== undefined) result.cwd = options.cwd;
  if (options.env !== undefined) result.env = options.env;
  if (options.stdin !== undefined) result.stdin = options.stdin;
  if (options.timeoutMs !== undefined) result.timeoutMs = options.timeoutMs;
  if (options.onStdout !== undefined) result.onStdout = options.onStdout;
  if (options.onStderr !== undefined) result.onStderr = options.onStderr;
  if (options.maxOutputBytes !== undefined) result.maxOutputBytes = options.maxOutputBytes;
  if (options.signal !== undefined) result.signal = options.signal;
  return result;
}

function createInstance(profile: SandboxProfile): SandboxInstance {
  // Mutable — set to true on destroy() to reject subsequent calls
  let destroyed = false;

  return {
    exec: async (
      command: string,
      args: readonly string[],
      options?: SandboxExecOptions,
    ): Promise<SandboxAdapterResult> => {
      if (destroyed) {
        throw new Error("SandboxInstance has been destroyed");
      }

      const result: Result<SandboxAdapterResult, KoiError> = await execute(
        profile,
        command,
        args,
        toExecuteOptions(options),
      );

      if (!result.ok) {
        throw new Error(result.error.message, { cause: result.error });
      }

      return result.value;
    },

    spawn: async (
      command: string,
      args: readonly string[],
      options?: SandboxSpawnOptions,
    ): Promise<SandboxProcessHandle> => {
      if (destroyed) {
        throw new Error("SandboxInstance has been destroyed");
      }

      const spawnResult: Result<SandboxProcess, KoiError> = spawn(profile, command, args, {
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options?.env !== undefined ? { env: options.env } : {}),
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      });

      if (!spawnResult.ok) {
        throw new Error(spawnResult.error.message, { cause: spawnResult.error });
      }

      const proc = spawnResult.value;

      return {
        pid: proc.pid,
        stdin: {
          write: (data: string | Uint8Array): void | Promise<void> => {
            const result = proc.stdin.write(data);
            if (result instanceof Promise) {
              return result.then(() => undefined);
            }
          },
          end: () => proc.stdin.end(),
        },
        stdout: proc.stdout,
        stderr: proc.stderr,
        exited: proc.exited,
        kill: proc.kill,
      };
    },

    readFile: async (path: string): Promise<Uint8Array> => {
      if (destroyed) {
        throw new Error("SandboxInstance has been destroyed");
      }
      // OS-level sandbox: read directly from host filesystem.
      // The sandbox profile controls what the spawned process can access,
      // but the host can read any file it has permission to.
      const file = Bun.file(path);
      return new Uint8Array(await file.arrayBuffer());
    },

    writeFile: async (path: string, content: Uint8Array): Promise<void> => {
      if (destroyed) {
        throw new Error("SandboxInstance has been destroyed");
      }
      await Bun.write(path, content);
    },

    destroy: async (): Promise<void> => {
      destroyed = true;
    },
  };
}
