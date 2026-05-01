import type { SandboxAdapterResult, SandboxExecOptions, SandboxInstance } from "@koi/core";
import type { ProfileDefaults } from "./profile.js";
import type { DaytonaRunOpts, DaytonaSdkSandbox } from "./types.js";

const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

function quoteArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function joinCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteArg).join(" ");
}

function truncateOutput(
  stdout: string,
  stderr: string,
  cap: number,
  sdkTruncated: boolean | undefined,
): { stdout: string; stderr: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const stdoutOver = encoder.encode(stdout).byteLength > cap;
  const stderrOver = encoder.encode(stderr).byteLength > cap;
  return {
    stdout: stdoutOver ? stdout.slice(0, cap) : stdout,
    stderr: stderrOver ? stderr.slice(0, cap) : stderr,
    truncated: sdkTruncated === true || stdoutOver || stderrOver,
  };
}

/**
 * Wrap a Daytona SDK workspace handle as a Koi `SandboxInstance`.
 *
 * `defaults` are forwarded into every per-call exec so profile-level `env`
 * and `timeoutMs` are honoured. Per-call options always win.
 *
 * Capability gating: callers that pass `stdin` or `maxOutputBytes` get a
 * fail-closed error when the injected SDK does not advertise support. `readFile`
 * requires `sdk.files.readBytes`.
 */
export function createDaytonaInstance(
  sdk: DaytonaSdkSandbox,
  defaults: ProfileDefaults = {},
): SandboxInstance {
  let destroyed = false;
  let destroyPending: Promise<void> | undefined;

  function ensureLive(op: string): void {
    if (destroyed) throw new Error(`sandbox-daytona: instance already destroyed (${op})`);
    if (destroyPending !== undefined) {
      throw new Error(`sandbox-daytona: instance is being destroyed (${op})`);
    }
  }

  return {
    exec: async (
      command: string,
      args: readonly string[],
      options?: SandboxExecOptions,
    ): Promise<SandboxAdapterResult> => {
      ensureLive("exec");

      if (options?.stdin !== undefined && sdk.commands.supportsStdin !== true) {
        throw new Error(
          "sandbox-daytona: SandboxExecOptions.stdin was provided but the injected SDK " +
            "does not advertise commands.supportsStdin=true.",
        );
      }
      if (options?.maxOutputBytes !== undefined && sdk.commands.supportsMaxOutputBytes !== true) {
        throw new Error(
          "sandbox-daytona: SandboxExecOptions.maxOutputBytes was provided but the injected SDK " +
            "does not advertise commands.supportsMaxOutputBytes=true.",
        );
      }
      if (options?.signal !== undefined && sdk.commands.supportsAbort !== true) {
        throw new Error(
          "sandbox-daytona: SandboxExecOptions.signal was provided but the injected SDK " +
            "does not advertise commands.supportsAbort=true. Without provider-side " +
            "kill confirmation, abort cannot be honoured safely.",
        );
      }

      const start = performance.now();
      const cmd = joinCommand(command, args);

      const mergedEnv =
        defaults.env !== undefined || options?.env !== undefined
          ? { ...(defaults.env ?? {}), ...(options?.env ?? {}) }
          : undefined;
      const mergedTimeout = options?.timeoutMs ?? defaults.timeoutMs;
      const cap = options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

      const sdkOpts: DaytonaRunOpts = {
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(mergedEnv !== undefined ? { envs: mergedEnv } : {}),
        ...(mergedTimeout !== undefined ? { timeoutMs: mergedTimeout } : {}),
        ...(options?.onStdout !== undefined ? { onStdout: options.onStdout } : {}),
        ...(options?.onStderr !== undefined ? { onStderr: options.onStderr } : {}),
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
        ...(sdk.commands.supportsMaxOutputBytes === true ? { maxOutputBytes: cap } : {}),
      };

      try {
        const result = await sdk.commands.run(cmd, sdkOpts);
        const durationMs = performance.now() - start;
        const capped = truncateOutput(result.stdout, result.stderr, cap, result.truncated);

        if (options?.signal?.aborted === true) {
          return {
            exitCode: 130,
            stdout: capped.stdout,
            stderr: capped.stderr,
            durationMs,
            timedOut: false,
            oomKilled: false,
            ...(capped.truncated ? { truncated: true } : {}),
          };
        }
        return {
          exitCode: result.exitCode,
          stdout: capped.stdout,
          stderr: capped.stderr,
          durationMs,
          timedOut: false,
          oomKilled: false,
          ...(capped.truncated ? { truncated: true } : {}),
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
      ensureLive("readFile");
      if (sdk.files.readBytes === undefined) {
        throw new Error(
          "sandbox-daytona: readFile requires sdk.files.readBytes for binary-safe reads. " +
            "Inject an SDK wrapper that exposes readBytes.",
        );
      }
      return sdk.files.readBytes(path);
    },

    writeFile: async (path: string, content: Uint8Array): Promise<void> => {
      ensureLive("writeFile");
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
     * Once `destroy()` is invoked, all subsequent `exec`/`readFile`/`writeFile`
     * calls reject — the lifecycle race is closed before the SDK confirms
     * teardown. Idempotent on success, retryable on transient failure.
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
