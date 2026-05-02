import type { SandboxAdapterResult, SandboxExecOptions, SandboxInstance } from "@koi/core";
import type { ProfileDefaults } from "./profile.js";
import type { E2bRunOpts, E2bSdkSandbox } from "./types.js";

/**
 * Default cap mirrors the core `SandboxExecOptions.maxOutputBytes` contract
 * (1 MB). The adapter only honours it server-side: if the injected SDK does
 * not advertise `commands.supportsMaxOutputBytes=true`, exec() refuses to
 * proceed rather than buffering unbounded output. A post-hoc trim of an
 * already-materialised payload would not actually bound memory or
 * bandwidth, so we fail closed and force callers to supply a cap-capable
 * wrapper.
 */
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
 * Apply a single combined-byte budget across stdout and stderr to the SDK's
 * authoritative final strings. The SDK's returned `stdout`/`stderr` are the
 * source of truth — streaming callbacks are advisory progress only, since we
 * cannot prove they're complete (chunked SDKs may emit prefixes and return
 * the full tail in the final result).
 *
 * stdout takes priority when the combined output exceeds the budget, since
 * stdout typically carries the primary command output.
 */
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
  // Combined budget exceeded — slice with stdout-first priority.
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
      // Output cap is mandatory: SandboxExecOptions documents a 1 MB default,
      // and a hosted backend must honour it before buffering. Without
      // server-side support, an explicit cap or the implicit default could
      // not be enforced, so refuse rather than expose the host process to
      // unbounded remote output.
      if (sdk.commands.supportsMaxOutputBytes !== true) {
        throw new Error(
          "sandbox-e2b: exec() requires commands.supportsMaxOutputBytes=true on the " +
            "injected SDK. The SandboxExecOptions contract guarantees a default 1 MB " +
            "cap on stdout+stderr; without server-side enforcement the adapter would " +
            "buffer unbounded output before any cap could apply. Inject a cap-capable " +
            "SDK wrapper.",
        );
      }
      // Reject malformed caps before they can defeat the trim. A negative
      // value collapses Uint8Array.slice(0, negative) into "keep almost
      // everything" and re-opens the unbounded-output path; NaN/Infinity
      // skip the comparison and surface oversized payloads. Validate fail-
      // closed instead of clamping silently.
      if (
        options?.maxOutputBytes !== undefined &&
        (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes < 0)
      ) {
        throw new Error(
          `sandbox-e2b: SandboxExecOptions.maxOutputBytes must be a non-negative ` +
            `integer; got ${String(options.maxOutputBytes)}.`,
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
      // The capability gate above guarantees `supportsMaxOutputBytes=true`,
      // so the cap is always forwarded — the contract default applies when
      // the caller omitted `maxOutputBytes`.
      const cap = options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

      const sdkOpts: E2bRunOpts = {
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(mergedEnv !== undefined ? { envs: mergedEnv } : {}),
        ...(mergedTimeout !== undefined ? { timeoutMs: mergedTimeout } : {}),
        // Streaming callbacks are advisory — pass caller's through unchanged
        // so they see live progress; the final SDK result is authoritative.
        ...(options?.onStdout !== undefined ? { onStdout: options.onStdout } : {}),
        ...(options?.onStderr !== undefined ? { onStderr: options.onStderr } : {}),
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
        maxOutputBytes: cap,
      };

      // Authoritative cancellation detection via Promise.race: the SDK's
      // resolution and the abort event compete at the same level, so the
      // winner unambiguously identifies which event happened first. A late
      // abort that fires AFTER the SDK already resolved cannot win the
      // race (settled-first promises beat pending ones in microtask FIFO),
      // so a finished command is never misreported as cancelled.
      const sdkPromise = sdk.commands.run(cmd, sdkOpts);
      const sig = options?.signal;
      type Settled =
        | {
            readonly kind: "result";
            readonly r: typeof sdkPromise extends Promise<infer R> ? R : never;
          }
        | { readonly kind: "error"; readonly e: unknown }
        | { readonly kind: "abort" };
      const sdkSettled: Promise<Settled> = sdkPromise.then(
        (r): Settled => ({ kind: "result", r }),
        (e: unknown): Settled => ({ kind: "error", e }),
      );
      const abortObserved: Promise<Settled> =
        sig === undefined
          ? new Promise<Settled>(() => {}) // never settles when no signal
          : new Promise<Settled>((resolve) => {
              sig.addEventListener("abort", () => resolve({ kind: "abort" }), { once: true });
            });

      const winner: Settled = await Promise.race([sdkSettled, abortObserved]);

      if (winner.kind === "abort") {
        // Per supportsAbort=true the SDK should settle once the remote
        // process is dead — but we cannot wait forever on a degraded
        // provider, or a hung transport would turn cancellation into a
        // permanent hang. Cap the kill-confirmation wait; on timeout
        // surface the cancel and quarantine the instance so callers do
        // not retry against a workspace whose lifecycle state is unknown.
        const POST_ABORT_KILL_CONFIRM_MS = 5_000;
        const confirmed = await Promise.race([
          sdkSettled.then(() => "settled" as const),
          new Promise<"timeout">((resolve) =>
            setTimeout(() => resolve("timeout"), POST_ABORT_KILL_CONFIRM_MS),
          ),
        ]);
        const durationMs = performance.now() - start;
        if (confirmed === "timeout") {
          // SDK never confirmed termination. The instance may still be
          // running remote side effects; force teardown so subsequent
          // ops reject and operators can revoke out-of-band.
          destroyed = true;
          return {
            exitCode: 130,
            stdout: "",
            stderr:
              "sandbox-e2b: abort timeout — SDK did not confirm remote " +
              `termination within ${POST_ABORT_KILL_CONFIRM_MS}ms. Instance has ` +
              "been quarantined; verify the workspace state out-of-band.",
            durationMs,
            timedOut: false,
            oomKilled: false,
          };
        }
        return {
          exitCode: 130,
          stdout: "",
          stderr: "",
          durationMs,
          timedOut: false,
          oomKilled: false,
        };
      }

      if (winner.kind === "error") {
        const durationMs = performance.now() - start;
        const e = winner.e;
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

      // winner.kind === "result"
      const result = winner.r;
      const durationMs = performance.now() - start;

      const capped = applyCombinedBudget(result.stdout, result.stderr, cap, result.truncated);
      const truncated = capped.truncated;

      // Map known exit-code conventions consistently with sandbox-docker so
      // callers see uniform timeout/OOM signals across backends.
      const timedOut = result.exitCode === 124;
      const oomKilled = result.exitCode === 137;

      return {
        exitCode: result.exitCode,
        stdout: capped.stdout,
        stderr: capped.stderr,
        durationMs,
        timedOut,
        oomKilled,
        ...(truncated ? { truncated: true as const } : {}),
      };
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
