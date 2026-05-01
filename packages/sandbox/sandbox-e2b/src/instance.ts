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
 * Byte-accurate truncation that respects UTF-8 codepoint boundaries.
 *
 * `String.slice` cuts UTF-16 code units; decoding a partial codepoint with
 * `fatal: false` substitutes U+FFFD whose 3-byte encoding can re-inflate past
 * the budget. Instead we walk back over any trailing continuation bytes so the
 * cut always lands on a complete codepoint boundary, then decode.
 */
function trimToUtf8Boundary(bytes: Uint8Array, maxBytes: number): Uint8Array {
  if (bytes.byteLength <= maxBytes) return bytes;
  let cut = maxBytes;
  // If the first excluded byte is a continuation (10xxxxxx), the slice ends
  // mid-codepoint. Walk back until that byte is a leading byte or ASCII.
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
  return {
    text: new TextDecoder("utf-8").decode(trimmed),
    truncated: true,
  };
}

/**
 * Streaming accumulator with a single combined byte budget across stdout and
 * stderr. Bounds local memory so a noisy SDK that ignores server-side caps
 * cannot blow up the process — once the cap is hit, further chunks are
 * dropped and `truncated` is set.
 */
interface OutputBudget {
  readonly stdoutChunks: Uint8Array[];
  readonly stderrChunks: Uint8Array[];
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
  const state = {
    stdoutChunks,
    stderrChunks,
    remaining: cap,
    truncated: false,
  };

  function append(target: "stdout" | "stderr", data: string): void {
    if (state.remaining <= 0) {
      state.truncated = true;
      return;
    }
    const bytes = encoder.encode(data);
    if (bytes.byteLength <= state.remaining) {
      // Fits entirely — append as-is.
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
    // Doesn't fit — trim to the last complete UTF-8 codepoint that fits in budget.
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
      const decoder = new TextDecoder("utf-8", { fatal: false });
      const merged = new Uint8Array(used);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
      }
      return decoder.decode(merged);
    }
    // Streaming callbacks didn't fire — fall back to the SDK's final string,
    // applying the *remaining* budget so the combined cap is still honoured.
    if (state.remaining <= 0) {
      state.truncated = true;
      return "";
    }
    const sliced = sliceByBytes(sdkFallback, state.remaining);
    state.remaining -= new TextEncoder().encode(sliced.text).byteLength;
    if (sliced.truncated) state.truncated = true;
    return sliced.text;
  }

  return {
    stdoutChunks,
    stderrChunks,
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

      // Pre-aborted signals must never reach the SDK — otherwise a caller that
      // cancels before dispatch could still trigger a remote side effect.
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

      // Wrap caller callbacks so we accumulate locally with a hard byte cap.
      // This keeps memory bounded even when the SDK emits more than `cap`.
      const wrappedStdout = (data: string): void => {
        budget.appendStdout(data);
        options?.onStdout?.(data);
      };
      const wrappedStderr = (data: string): void => {
        budget.appendStderr(data);
        options?.onStderr?.(data);
      };

      const sdkOpts: E2bRunOpts = {
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
        // Always await the SDK call. When `supportsAbort` is true the SDK is
        // contractually required to settle this promise after the remote
        // process is gone, so we never report cancellation before termination.
        const result = await sdk.commands.run(cmd, sdkOpts);
        const durationMs = performance.now() - start;

        // Apply the combined budget: streaming-accumulator output (when the SDK
        // fired callbacks) is preferred; otherwise we slice the SDK's final
        // strings against the *remaining* budget so the combined cap holds.
        const stdout = budget.resolveStdout(result.stdout);
        const stderr = budget.resolveStderr(result.stderr);
        const truncated = budget.truncated || result.truncated === true;

        // Map known exit-code conventions consistently with sandbox-docker so
        // callers see uniform timeout/OOM signals across backends.
        const timedOut = result.exitCode === 124;
        const oomKilled = result.exitCode === 137;

        const baseResult = {
          stdout,
          stderr,
          durationMs,
          ...(truncated ? { truncated: true as const } : {}),
        };
        // Re-read `aborted` here — TS narrows after the pre-abort guard, but
        // the signal could have aborted *during* the SDK call.
        const abortedNow: boolean = options?.signal?.aborted ?? false;
        if (abortedNow) {
          return { exitCode: 130, timedOut: false, oomKilled: false, ...baseResult };
        }
        return { exitCode: result.exitCode, timedOut, oomKilled, ...baseResult };
      } catch (e: unknown) {
        const durationMs = performance.now() - start;
        const message = e instanceof Error ? e.message : String(e);
        // If the caller cancelled, classify the rejection as cancellation
        // rather than a generic failure — preserves retry-safety semantics.
        const abortedNow: boolean = options?.signal?.aborted ?? false;
        const looksLikeAbort =
          e instanceof Error &&
          (e.name === "AbortError" || /aborted|cancel(led)?/i.test(e.message));
        if (abortedNow || looksLikeAbort) {
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
