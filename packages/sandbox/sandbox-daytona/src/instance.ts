import type { SandboxAdapterResult, SandboxExecOptions, SandboxInstance } from "@koi/core";
import type { ProfileDefaults } from "./profile.js";
import type { DaytonaRunOpts, DaytonaSdkSandbox } from "./types.js";

function quoteArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function joinCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteArg).join(" ");
}

function abortedResult(durationMs: number): SandboxAdapterResult {
  return {
    exitCode: 130,
    stdout: "",
    stderr: "",
    durationMs,
    timedOut: false,
    oomKilled: false,
  };
}

/**
 * Wrap a Daytona SDK workspace handle as a Koi `SandboxInstance`.
 *
 * `defaults` are forwarded into every per-call exec so profile-level `env`
 * and `timeoutMs` are honoured. Per-call options always win.
 */
export function createDaytonaInstance(
  sdk: DaytonaSdkSandbox,
  defaults: ProfileDefaults = {},
): SandboxInstance {
  let destroyed = false;
  let destroyPending: Promise<void> | undefined;

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
        return abortedResult(0);
      }

      const start = performance.now();
      const cmd = joinCommand(command, args);

      const mergedEnv =
        defaults.env !== undefined || options?.env !== undefined
          ? { ...(defaults.env ?? {}), ...(options?.env ?? {}) }
          : undefined;
      const mergedTimeout = options?.timeoutMs ?? defaults.timeoutMs;

      const sdkOpts: DaytonaRunOpts = {
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(mergedEnv !== undefined ? { envs: mergedEnv } : {}),
        ...(mergedTimeout !== undefined ? { timeoutMs: mergedTimeout } : {}),
        ...(options?.onStdout !== undefined ? { onStdout: options.onStdout } : {}),
        ...(options?.onStderr !== undefined ? { onStderr: options.onStderr } : {}),
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      };

      const runPromise = sdk.commands.run(cmd, sdkOpts);

      const signal = options?.signal;
      try {
        let result: { exitCode: number; stdout: string; stderr: string };
        if (signal !== undefined) {
          result = await new Promise<typeof result>((resolve, reject) => {
            const onAbort = (): void => {
              resolve({ exitCode: 130, stdout: "", stderr: "" });
            };
            signal.addEventListener("abort", onAbort, { once: true });
            runPromise.then(
              (r) => {
                signal.removeEventListener("abort", onAbort);
                resolve(r);
              },
              (e: unknown) => {
                signal.removeEventListener("abort", onAbort);
                reject(e instanceof Error ? e : new Error(String(e)));
              },
            );
          });
        } else {
          result = await runPromise;
        }

        const durationMs = performance.now() - start;
        if (signal?.aborted === true && result.exitCode === 130) {
          return abortedResult(durationMs);
        }
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
      if (sdk.files.readBytes !== undefined) return sdk.files.readBytes(path);
      const content = await sdk.files.read(path);
      return new TextEncoder().encode(content);
    },

    writeFile: async (path: string, content: Uint8Array): Promise<void> => {
      if (destroyed) throw new Error("sandbox-daytona: instance already destroyed");
      if (sdk.files.writeBytes !== undefined) {
        await sdk.files.writeBytes(path, content);
        return;
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(content);
      } catch (e: unknown) {
        throw new Error(
          "sandbox-daytona: writeFile received non-UTF-8 bytes and the SDK wrapper does not expose writeBytes. " +
            "Provide a binary-safe SDK client to write arbitrary content.",
          { cause: e },
        );
      }
      await sdk.files.write(path, text);
    },

    /**
     * Tear down the remote workspace.
     *
     * Idempotent on success; on transient SDK failure, `destroyed` stays
     * `false` so callers can retry. Concurrent calls coalesce onto a single
     * in-flight teardown.
     */
    destroy: async (): Promise<void> => {
      if (destroyed) return;
      if (destroyPending !== undefined) return destroyPending;
      destroyPending = (async () => {
        try {
          await sdk.close();
          destroyed = true;
        } finally {
          destroyPending = undefined;
        }
      })();
      return destroyPending;
    },
  };
}
