import type { SandboxAdapterResult, SandboxExecOptions, SandboxInstance } from "@koi/core";
import type { DaytonaRunOpts, DaytonaSdkSandbox } from "./types.js";

function quoteArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function joinCommand(command: string, args: readonly string[]): string {
  if (args.length === 0) return command;
  return `${command} ${args.map(quoteArg).join(" ")}`;
}

/** Wrap a Daytona SDK workspace handle as a Koi `SandboxInstance`. */
export function createDaytonaInstance(sdk: DaytonaSdkSandbox): SandboxInstance {
  let destroyed = false;

  return {
    exec: async (
      command: string,
      args: readonly string[],
      options?: SandboxExecOptions,
    ): Promise<SandboxAdapterResult> => {
      if (destroyed) {
        throw new Error("sandbox-daytona: instance already destroyed");
      }
      if (options?.signal?.aborted === true) {
        return {
          exitCode: 130,
          stdout: "",
          stderr: "",
          durationMs: 0,
          timedOut: false,
          oomKilled: false,
        };
      }

      const start = performance.now();
      const cmd = joinCommand(command, args);
      const sdkOpts: DaytonaRunOpts = {
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options?.env !== undefined ? { envs: { ...options.env } } : {}),
        ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options?.onStdout !== undefined ? { onStdout: options.onStdout } : {}),
        ...(options?.onStderr !== undefined ? { onStderr: options.onStderr } : {}),
      };

      try {
        const result = await sdk.commands.run(cmd, sdkOpts);
        const durationMs = performance.now() - start;
        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs,
          timedOut: false,
          oomKilled: false,
        };
      } catch (e: unknown) {
        const durationMs = performance.now() - start;
        const message = e instanceof Error ? e.message : String(e);
        const timedOut = /timeout|timed out/i.test(message);
        return {
          exitCode: 1,
          stdout: "",
          stderr: message,
          durationMs,
          timedOut,
          oomKilled: false,
        };
      }
    },

    readFile: async (path: string): Promise<Uint8Array> => {
      if (destroyed) throw new Error("sandbox-daytona: instance already destroyed");
      const content = await sdk.files.read(path);
      return new TextEncoder().encode(content);
    },

    writeFile: async (path: string, content: Uint8Array): Promise<void> => {
      if (destroyed) throw new Error("sandbox-daytona: instance already destroyed");
      const text = new TextDecoder().decode(content);
      await sdk.files.write(path, text);
    },

    destroy: async (): Promise<void> => {
      if (destroyed) return;
      destroyed = true;
      await sdk.close();
    },
  };
}
