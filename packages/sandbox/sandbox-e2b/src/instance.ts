import type { SandboxAdapterResult, SandboxExecOptions, SandboxInstance } from "@koi/core";
import type { ProfileDefaults } from "./profile.js";
import type { E2bRunOpts, E2bSdkSandbox } from "./types.js";

/** Mirrors the default capture cap documented in `SandboxExecOptions.maxOutputBytes`. */
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

function quoteArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function joinCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteArg).join(" ");
}

/**
 * Local guarantee for the `maxOutputBytes` contract: regardless of whether the
 * SDK honoured the cap server-side, slice stdout/stderr down to the limit and
 * report `truncated` so callers see consistent behaviour.
 */
function truncateOutput(
  stdout: string,
  stderr: string,
  cap: number,
  sdkTruncated: boolean | undefined,
): { stdout: string; stderr: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const stdoutBytes = encoder.encode(stdout).byteLength;
  const stderrBytes = encoder.encode(stderr).byteLength;
  const stdoutOver = stdoutBytes > cap;
  const stderrOver = stderrBytes > cap;
  return {
    stdout: stdoutOver ? stdout.slice(0, cap) : stdout,
    stderr: stderrOver ? stderr.slice(0, cap) : stderr,
    truncated: sdkTruncated === true || stdoutOver || stderrOver,
  };
}

/**
 * Wrap an E2B SDK sandbox handle as a Koi `SandboxInstance`.
 *
 * `defaults` are forwarded into every per-call exec so profile-level `env`
 * and `timeoutMs` are honoured even when callers don't repeat them in
 * `SandboxExecOptions`. Per-call options always win over defaults.
 *
 * Capability gating: callers that pass `stdin` or `maxOutputBytes` get a
 * fail-closed error when the injected SDK does not advertise support, rather
 * than a silent drop. `readFile` likewise requires `sdk.files.readBytes` —
 * the text-only fallback is non-binary-safe, so it is refused.
 */
export function createE2bInstance(
  sdk: E2bSdkSandbox,
  defaults: ProfileDefaults = {},
): SandboxInstance {
  let destroyed = false;
  let destroyPending: Promise<void> | undefined;

  function ensureLive(op: string): void {
    if (destroyed) throw new Error(`sandbox-e2b: instance already destroyed (${op})`);
    if (destroyPending !== undefined) {
      throw new Error(`sandbox-e2b: instance is being destroyed (${op})`);
    }
  }

  return {
    exec: async (
      command: string,
      args: readonly string[],
      options?: SandboxExecOptions,
    ): Promise<SandboxAdapterResult> => {
      ensureLive("exec");

      // Capability gating — refuse rather than silently drop.
      if (options?.stdin !== undefined && sdk.commands.supportsStdin !== true) {
        throw new Error(
          "sandbox-e2b: SandboxExecOptions.stdin was provided but the injected SDK " +
            "does not advertise commands.supportsStdin=true. Use a stdin-capable wrapper.",
        );
      }
      if (options?.maxOutputBytes !== undefined && sdk.commands.supportsMaxOutputBytes !== true) {
        throw new Error(
          "sandbox-e2b: SandboxExecOptions.maxOutputBytes was provided but the injected SDK " +
            "does not advertise commands.supportsMaxOutputBytes=true.",
        );
      }
      if (options?.signal !== undefined && sdk.commands.supportsAbort !== true) {
        // Fail-closed: returning before the remote command was actually killed
        // would let callers retry while the original is still running, leading
        // to duplicate side effects.
        throw new Error(
          "sandbox-e2b: SandboxExecOptions.signal was provided but the injected SDK " +
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

      const sdkOpts: E2bRunOpts = {
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(mergedEnv !== undefined ? { envs: mergedEnv } : {}),
        ...(mergedTimeout !== undefined ? { timeoutMs: mergedTimeout } : {}),
        ...(options?.onStdout !== undefined ? { onStdout: options.onStdout } : {}),
        ...(options?.onStderr !== undefined ? { onStderr: options.onStderr } : {}),
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
        // Always forward a cap when the SDK supports it — applies the contract
        // default even when the caller didn't ask for one. Server-side cap
        // bounds bandwidth; local truncation below bounds memory regardless.
        ...(sdk.commands.supportsMaxOutputBytes === true ? { maxOutputBytes: cap } : {}),
      };

      try {
        // Always await the SDK call. When `supportsAbort` is true the SDK is
        // contractually required to settle this promise after the remote
        // process is gone, so we never report cancellation before termination.
        const result = await sdk.commands.run(cmd, sdkOpts);
        const durationMs = performance.now() - start;
        const capped = truncateOutput(result.stdout, result.stderr, cap, result.truncated);

        if (options?.signal?.aborted === true) {
          // SDK honoured the abort; surface the standard cancellation result
          // rather than the SDK's exit code (which may be provider-specific).
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
      // No text-only fallback: the SandboxInstance contract is byte-oriented.
      // Re-encoding a string read through TextEncoder would silently corrupt
      // non-UTF-8 payloads, so refuse rather than weaken the contract.
      if (sdk.files.readBytes === undefined) {
        throw new Error(
          "sandbox-e2b: readFile requires sdk.files.readBytes for binary-safe reads. " +
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
      // Text-mode fallback: only succeeds for UTF-8 payloads.
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(content);
      } catch (e: unknown) {
        throw new Error(
          "sandbox-e2b: writeFile received non-UTF-8 bytes and the SDK wrapper does not expose writeBytes. " +
            "Provide a binary-safe SDK client to write arbitrary content.",
          { cause: e },
        );
      }
      await sdk.files.write(path, text);
    },

    /**
     * Tear down the remote sandbox.
     *
     * Once `destroy()` is invoked, all subsequent `exec`/`readFile`/`writeFile`
     * calls reject — the lifecycle race is closed before the SDK confirms
     * teardown. Idempotent on success; on transient SDK failure, `destroyed`
     * stays `false` so callers can retry. Concurrent calls coalesce.
     */
    destroy: async (): Promise<void> => {
      if (destroyed) return;
      if (destroyPending !== undefined) return destroyPending;
      destroyPending = (async () => {
        try {
          await sdk.kill();
          destroyed = true;
        } finally {
          destroyPending = undefined;
        }
      })();
      return destroyPending;
    },
  };
}
