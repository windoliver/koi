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
  // Quarantine is a soft variant of destroyed: it blocks new exec/file ops
  // (the SDK lifecycle is unknown) but still allows destroy() to attempt
  // teardown. Setting destroyed=true straight away in the abort-timeout
  // path would be wrong — it removes the only programmatic way to kill a
  // possibly-still-running remote sandbox.
  let quarantined = false;
  // Single-flight teardown: the actual sdk.kill() promise survives the
  // local TEARDOWN_TIMEOUT_MS so retries attach to the in-flight call
  // instead of issuing a second remote kill against the same sandbox.
  // Cleared on settlement (success → destroyed; rejection → caller may
  // retry with a fresh kill).
  type KillOutcome = { readonly kind: "ok" } | { readonly kind: "err"; readonly e: unknown };
  let killInFlight: Promise<KillOutcome> | undefined;

  function ensureLive(op: string): void {
    if (destroyed) throw new Error(`sandbox-e2b: instance already destroyed (${op})`);
    if (quarantined) {
      throw new Error(
        `sandbox-e2b: instance is quarantined after a kill-confirmation timeout ` +
          `(${op}); call destroy() to attempt cleanup.`,
      );
    }
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
      const sig = options?.signal;
      type SdkOutcome =
        | {
            readonly kind: "result";
            readonly r: Awaited<ReturnType<typeof sdk.commands.run>>;
          }
        | { readonly kind: "error"; readonly e: unknown };
      type Settled = SdkOutcome | { readonly kind: "abort" };
      // Build the abort observer BEFORE dispatching the SDK so any abort
      // that fires between the pre-aborted check and the listener attach
      // is not silently lost. addEventListener does not replay past
      // events, so we also re-check `sig.aborted` synchronously after
      // attach: if the signal flipped during the microtask gap, resolve
      // immediately rather than waiting for an event that will never fire.
      const abortObserved: Promise<Settled> =
        sig === undefined
          ? new Promise<Settled>(() => {}) // never settles when no signal
          : new Promise<Settled>((resolve) => {
              sig.addEventListener("abort", () => resolve({ kind: "abort" }), { once: true });
              if (sig.aborted) resolve({ kind: "abort" });
            });
      const sdkPromise = sdk.commands.run(cmd, sdkOpts);
      const sdkSettled: Promise<SdkOutcome> = sdkPromise.then(
        (r): SdkOutcome => ({ kind: "result", r }),
        (e: unknown): SdkOutcome => ({ kind: "error", e }),
      );

      const winner: Settled = await Promise.race<Settled>([sdkSettled, abortObserved]);

      if (winner.kind === "abort") {
        // Per supportsAbort=true the SDK should settle once the remote
        // process is dead — but we cannot wait forever on a degraded
        // provider. Cap the kill-confirmation wait, then INSPECT the
        // settled outcome: only a true cancellation signal (AbortError /
        // standard kill exit codes) maps to 130. A successful completion
        // that landed just after the abort signal must be propagated as
        // success — replaying it would duplicate side effects.
        const POST_ABORT_KILL_CONFIRM_MS = 5_000;
        type Confirmed =
          | { readonly kind: "settled"; readonly s: SdkOutcome }
          | { readonly kind: "timeout" };
        const confirmed: Confirmed = await Promise.race<Confirmed>([
          sdkSettled.then((s): Confirmed => ({ kind: "settled", s })),
          new Promise<Confirmed>((resolve) =>
            setTimeout(() => resolve({ kind: "timeout" }), POST_ABORT_KILL_CONFIRM_MS),
          ),
        ]);
        const durationMs = performance.now() - start;
        if (confirmed.kind === "timeout") {
          // Indeterminate — the remote command may still be running.
          quarantined = true;
          return {
            exitCode: 1,
            stdout: "",
            stderr:
              "sandbox-e2b: abort timeout — SDK did not confirm remote " +
              `termination within ${POST_ABORT_KILL_CONFIRM_MS}ms. Remote command ` +
              "state is INDETERMINATE; the original may still be running. Do NOT " +
              "treat this as a clean cancellation — verify out-of-band before " +
              "retrying the command. Instance has been quarantined.",
            durationMs,
            timedOut: false,
            oomKilled: false,
          };
        }
        const settled = confirmed.s;
        // SDK rejected with AbortError → provider-confirmed cancellation.
        if (settled.kind === "error") {
          const e = settled.e;
          if (e instanceof Error && e.name === "AbortError") {
            return {
              exitCode: 130,
              stdout: "",
              stderr: "",
              durationMs,
              timedOut: false,
              oomKilled: false,
            };
          }
          // Some other rejection arrived in the post-abort window. We
          // cannot prove the command was killed cleanly, so return the
          // failure verbatim rather than synthesising a clean cancel.
          const message = e instanceof Error ? e.message : String(e);
          return {
            exitCode: 1,
            stdout: "",
            stderr: message,
            durationMs,
            timedOut: false,
            oomKilled: false,
          };
        }
        // SDK resolved with a result. The conventional kill exit codes
        // (130 SIGINT, 137 SIGKILL, 143 SIGTERM) confirm cancellation.
        // Anything else — including exit 0 — means the command actually
        // completed; propagate it so callers see the real outcome and
        // don't replay finished side effects.
        const r = settled.r;
        const isKillExit = r.exitCode === 130 || r.exitCode === 137 || r.exitCode === 143;
        if (isKillExit) {
          return {
            exitCode: 130,
            stdout: "",
            stderr: "",
            durationMs,
            timedOut: false,
            oomKilled: false,
          };
        }
        const cappedAbort = applyCombinedBudget(r.stdout, r.stderr, cap, r.truncated);
        return {
          exitCode: r.exitCode,
          stdout: cappedAbort.stdout,
          stderr: cappedAbort.stderr,
          durationMs,
          timedOut: r.exitCode === 124,
          oomKilled: r.exitCode === 137,
          ...(cappedAbort.truncated ? { truncated: true as const } : {}),
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
     * Tear down the remote sandbox with a bounded SDK call. A stalled
     * `sdk.kill()` would otherwise wedge `destroyPending` forever, leaving
     * every subsequent op rejecting with "being destroyed" and no retry
     * path. On timeout we transition to the `quarantined` state, surface
     * a clear leak warning, and clear `destroyPending` so callers can
     * retry. Idempotent on success; concurrent calls coalesce.
     */
    destroy: async (): Promise<void> => {
      if (destroyed) return;
      if (destroyPending !== undefined) return destroyPending;
      const TEARDOWN_TIMEOUT_MS = 10_000;
      destroyPending = (async () => {
        // Single-flight: reuse an existing in-flight kill from a prior
        // timed-out attempt. Issuing a second remote kill while the first
        // is still pending breaks coalescing — duplicate provider
        // mutations, racy partial-failure paths, idempotency-skew bugs.
        if (killInFlight === undefined) {
          const teardown = sdk.kill();
          killInFlight = teardown.then(
            (): KillOutcome => ({ kind: "ok" }),
            (e: unknown): KillOutcome => ({ kind: "err", e }),
          );
          // Late convergence + cleanup. Runs regardless of whether the
          // current destroy() call has already returned.
          killInFlight.then((r) => {
            if (r.kind === "ok") {
              destroyed = true;
              quarantined = false;
            }
            // Clear the marker so a future destroy() can issue a fresh
            // kill if the previous one rejected (and operators want to
            // retry against a recovering provider).
            killInFlight = undefined;
          });
        }
        const inFlight = killInFlight;
        try {
          const outcome = await Promise.race([
            inFlight,
            new Promise<{ kind: "timeout" }>((resolve) =>
              setTimeout(() => resolve({ kind: "timeout" }), TEARDOWN_TIMEOUT_MS),
            ),
          ]);
          if (outcome.kind === "ok") {
            destroyed = true;
            return;
          }
          if (outcome.kind === "timeout") {
            // Quarantine and surface a leak warning. We do NOT mark
            // destroyed: the remote sandbox state is unknown. The
            // original sdk.kill() stays in flight (tracked via
            // killInFlight) — late success will still flip destroyed,
            // and a retry will attach to it instead of issuing a second
            // overlapping kill. If the original eventually rejects,
            // killInFlight clears and a future retry can issue a fresh
            // kill against a recovering provider.
            quarantined = true;
            throw new Error(
              `sandbox-e2b: destroy() timed out after ${TEARDOWN_TIMEOUT_MS}ms — ` +
                "sdk.kill() did not settle within the local bound. The remote sandbox " +
                "MAY still be running; verify out-of-band. Instance is quarantined. " +
                "Retries will attach to the still-pending teardown rather than issue " +
                "a second remote kill.",
            );
          }
          // outcome.kind === "err"
          const e = outcome.e;
          throw e instanceof Error ? e : new Error(String(e));
        } finally {
          destroyPending = undefined;
        }
      })();
      return destroyPending;
    },
  };
}
