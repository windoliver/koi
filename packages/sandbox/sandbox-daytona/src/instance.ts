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

interface OutputBudget {
  remaining: number;
  truncated: boolean;
  appendStdout: (data: string) => void;
  appendStderr: (data: string) => void;
  resolveStdout: (sdkFallback: string) => string;
  resolveStderr: (sdkFallback: string) => string;
}

function createOutputBudget(cap: number): OutputBudget {
  const encoder = new TextEncoder();
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const state = { remaining: cap, truncated: false };

  function append(target: "stdout" | "stderr", data: string): void {
    if (state.remaining <= 0) {
      state.truncated = true;
      return;
    }
    const bytes = encoder.encode(data);
    if (bytes.byteLength <= state.remaining) {
      if (target === "stdout") {
        stdoutChunks.push(bytes);
        stdoutBytes += bytes.byteLength;
      } else {
        stderrChunks.push(bytes);
        stderrBytes += bytes.byteLength;
      }
      state.remaining -= bytes.byteLength;
      return;
    }
    const trimmed = trimToUtf8Boundary(bytes, state.remaining);
    if (trimmed.byteLength > 0) {
      if (target === "stdout") {
        stdoutChunks.push(trimmed);
        stdoutBytes += trimmed.byteLength;
      } else {
        stderrChunks.push(trimmed);
        stderrBytes += trimmed.byteLength;
      }
      state.remaining -= trimmed.byteLength;
    }
    state.truncated = true;
  }

  function resolve(target: "stdout" | "stderr", sdkFallback: string): string {
    const chunks = target === "stdout" ? stdoutChunks : stderrChunks;
    const used = target === "stdout" ? stdoutBytes : stderrBytes;
    if (used > 0) {
      const merged = new Uint8Array(used);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
      }
      return new TextDecoder("utf-8", { fatal: false }).decode(merged);
    }
    if (state.remaining <= 0) {
      state.truncated = true;
      return "";
    }
    const sliced = sliceByBytes(sdkFallback, state.remaining);
    state.remaining -= encoder.encode(sliced.text).byteLength;
    if (sliced.truncated) state.truncated = true;
    return sliced.text;
  }

  return {
    get remaining() {
      return state.remaining;
    },
    set remaining(v: number) {
      state.remaining = v;
    },
    get truncated() {
      return state.truncated;
    },
    set truncated(v: boolean) {
      state.truncated = v;
    },
    appendStdout: (d) => append("stdout", d),
    appendStderr: (d) => append("stderr", d),
    resolveStdout: (s) => resolve("stdout", s),
    resolveStderr: (s) => resolve("stderr", s),
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
      const budget = createOutputBudget(cap);

      const wrappedStdout = (data: string): void => {
        budget.appendStdout(data);
        options?.onStdout?.(data);
      };
      const wrappedStderr = (data: string): void => {
        budget.appendStderr(data);
        options?.onStderr?.(data);
      };

      const sdkOpts: DaytonaRunOpts = {
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(mergedEnv !== undefined ? { envs: mergedEnv } : {}),
        ...(mergedTimeout !== undefined ? { timeoutMs: mergedTimeout } : {}),
        onStdout: wrappedStdout,
        onStderr: wrappedStderr,
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
        ...(sdk.commands.supportsMaxOutputBytes === true ? { maxOutputBytes: cap } : {}),
      };

      try {
        const result = await sdk.commands.run(cmd, sdkOpts);
        const durationMs = performance.now() - start;

        const stdout = budget.resolveStdout(result.stdout);
        const stderr = budget.resolveStderr(result.stderr);
        const truncated = budget.truncated || result.truncated === true;

        const baseResult = {
          stdout,
          stderr,
          durationMs,
          timedOut: false,
          oomKilled: false,
          ...(truncated ? { truncated: true as const } : {}),
        };
        const abortedNow: boolean = options?.signal?.aborted ?? false;
        if (abortedNow) {
          return { exitCode: 130, ...baseResult };
        }
        return { exitCode: result.exitCode, ...baseResult };
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
