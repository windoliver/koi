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

function trimToUtf8Boundary(bytes: Uint8Array, maxBytes: number): Uint8Array {
  if (bytes.byteLength <= maxBytes) return bytes;
  let cut = maxBytes;
  while (cut > 0) {
    const b = bytes[cut];
    if (b === undefined || (b & 0xc0) !== 0x80) break;
    cut--;
  }
  return bytes.slice(0, cut);
}

function sliceByBytes(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(s);
  if (bytes.byteLength <= maxBytes) return { text: s, truncated: false };
  const trimmed = trimToUtf8Boundary(bytes, maxBytes);
  return { text: new TextDecoder("utf-8").decode(trimmed), truncated: true };
}

function applyCombinedBudget(
  stdout: string,
  stderr: string,
  cap: number,
  sdkTruncated: boolean | undefined,
): { stdout: string; stderr: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const stdoutBytes = encoder.encode(stdout).byteLength;
  const stderrBytes = encoder.encode(stderr).byteLength;
  if (stdoutBytes + stderrBytes <= cap) {
    return { stdout, stderr, truncated: sdkTruncated === true };
  }
  const stdoutKeep = Math.min(stdoutBytes, cap);
  const stdoutSliced = sliceByBytes(stdout, stdoutKeep);
  const usedAfterStdout = encoder.encode(stdoutSliced.text).byteLength;
  const remaining = cap - usedAfterStdout;
  const stderrSliced =
    remaining > 0 ? sliceByBytes(stderr, remaining) : { text: "", truncated: stderrBytes > 0 };
  return {
    stdout: stdoutSliced.text,
    stderr: stderrSliced.text,
    truncated: true,
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

      // Pre-aborted signal must never reach the SDK.
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

        const capped = applyCombinedBudget(result.stdout, result.stderr, cap, result.truncated);
        const stdout = capped.stdout;
        const stderr = capped.stderr;
        const truncated = capped.truncated;

        const timedOut = result.exitCode === 124;
        const oomKilled = result.exitCode === 137;

        const baseResult = {
          stdout,
          stderr,
          durationMs,
          ...(truncated ? { truncated: true as const } : {}),
        };
        // Trust the SDK's resolved result. A signal that aborts after the
        // command has already finished must NOT rewrite the exit code to 130
        // — callers would conclude their side-effecting command was cancelled
        // and retry it, when it actually ran to completion. Cancellation is
        // only honoured when the SDK itself signals it (handled in catch).
        return { exitCode: result.exitCode, timedOut, oomKilled, ...baseResult };
      } catch (e: unknown) {
        const durationMs = performance.now() - start;
        const message = e instanceof Error ? e.message : String(e);
        // Only treat as caller cancellation when the caller actually aborted
        // the supplied signal. AbortError-shaped rejections from server-side
        // eviction or transport failures must surface as failures, otherwise
        // higher layers will retry-or-skip work that may have partially run.
        const sig: AbortSignal | undefined = options?.signal;
        if (sig !== undefined && sig.aborted) {
          return {
            exitCode: 130,
            stdout: "",
            stderr: "",
            durationMs,
            timedOut: false,
            oomKilled: false,
          };
        }
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
     * Permanently delete the remote workspace.
     *
     * Requires `sdk.delete` (genuine workspace deletion). Several Daytona SDK
     * versions implement `close()` as a client-side detach that leaves the
     * workspace running and billable, so the adapter refuses to fall back to
     * `close()` — calling it would mark the instance destroyed locally while
     * the remote workspace silently keeps running. Production callers must
     * inject a `delete`-capable SDK wrapper.
     *
     * Once `destroy()` resolves, all subsequent `exec`/`readFile`/`writeFile`
     * calls reject. Only marks `destroyed = true` after `sdk.delete()` settles
     * so transient failures stay retryable; concurrent calls coalesce.
     */
    destroy: async (): Promise<void> => {
      if (destroyed) return;
      if (destroyPending !== undefined) return destroyPending;
      if (sdk.delete === undefined) {
        throw new Error(
          "sandbox-daytona: destroy() requires sdk.delete to permanently delete the " +
            "remote workspace. The injected SDK exposes only close(), which in several " +
            "Daytona versions is a client-side detach that leaves the workspace running " +
            "and billable. Inject a delete-capable wrapper.",
        );
      }
      destroyPending = (async () => {
        try {
          // Call as a method so real SDK implementations that depend on `this`
          // get the correct receiver; copying into a local would lose it.
          await sdk.delete?.();
          destroyed = true;
        } finally {
          destroyPending = undefined;
        }
      })();
      return destroyPending;
    },
  };
}
