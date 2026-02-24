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
  SandboxProfile,
} from "@koi/core";
import type { ExecuteOptions } from "./execute.js";
import { execute } from "./execute.js";

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
  const result: { cwd?: string; env?: Readonly<Record<string, string>>; stdin?: string } = {};
  if (options.cwd !== undefined) result.cwd = options.cwd;
  if (options.env !== undefined) result.env = options.env;
  if (options.stdin !== undefined) result.stdin = options.stdin;
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
