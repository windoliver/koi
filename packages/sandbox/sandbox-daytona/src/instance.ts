import type { SandboxAdapterResult, SandboxExecOptions, SandboxInstance } from "@koi/core";
import type { ProfileDefaults } from "./profile.js";
import type { DaytonaRunOpts, DaytonaSdkSandbox } from "./types.js";

/** Default cap mirrors `SandboxExecOptions.maxOutputBytes`; honoured server-side. */
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
  // Soft variant of destroyed: blocks new ops but still allows destroy()
  // to attempt the authoritative SDK delete. The abort-timeout path uses
  // this so the only programmatic teardown path remains available.
  let quarantined = false;
  // Single-flight teardown: the actual sdk.delete() promise survives the
  // local TEARDOWN_TIMEOUT_MS so retries attach to the in-flight call
  // rather than issuing a second remote delete against the same workspace.
  type DeleteOutcome = { readonly kind: "ok" } | { readonly kind: "err"; readonly e: unknown };
  let deleteInFlight: Promise<DeleteOutcome> | undefined;

  // Bound remote file I/O so a stalled control plane cannot wedge
  // callers indefinitely. On timeout or rejection the remote write may
  // have been partially applied — quarantine to prevent retry compounding.
  const FILE_IO_TIMEOUT_MS = 30_000;
  async function runBoundedFileOp<T>(op: string, path: string, call: () => Promise<T>): Promise<T> {
    type Outcome =
      | { readonly kind: "ok"; readonly v: T }
      | { readonly kind: "err"; readonly e: unknown }
      | { readonly kind: "timeout" };
    const outcome = await Promise.race<Outcome>([
      // Promise.try converts a synchronous throw inside call() into a
      // rejection so the quarantine path always runs. A bare call().then()
      // would let a sync-throwing SDK wrapper escape this helper entirely
      // and leave the instance "live" with INDETERMINATE remote state.
      Promise.try(call).then(
        (v): Outcome => ({ kind: "ok", v }),
        (e: unknown): Outcome => ({ kind: "err", e }),
      ),
      new Promise<Outcome>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), FILE_IO_TIMEOUT_MS),
      ),
    ]);
    if (outcome.kind === "ok") return outcome.v;
    if (outcome.kind === "timeout") {
      quarantined = true;
      throw new Error(
        `sandbox-daytona: ${op}(${path}) did not settle within ${FILE_IO_TIMEOUT_MS}ms — ` +
          `remote filesystem state is INDETERMINATE; the operation may have partially ` +
          `applied. Instance has been quarantined; call destroy() before retrying.`,
      );
    }
    quarantined = true;
    const e = outcome.e;
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(
      `sandbox-daytona: ${op}(${path}) rejected; remote filesystem state is INDETERMINATE — ` +
        `instance quarantined (call destroy() to attempt cleanup): ${message}`,
      { cause: e },
    );
  }

  function ensureLive(op: string): void {
    if (destroyed) throw new Error(`sandbox-daytona: instance already destroyed (${op})`);
    if (quarantined) {
      throw new Error(
        `sandbox-daytona: instance is quarantined after a kill-confirmation timeout ` +
          `(${op}); call destroy() to attempt cleanup.`,
      );
    }
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
      // Output cap is mandatory: the SandboxExecOptions contract guarantees
      // a 1 MB default on stdout+stderr, and a hosted backend must honour it
      // before buffering. Without server-side enforcement an unbounded
      // payload could already be in memory by the time any cap applied.
      if (sdk.commands.supportsMaxOutputBytes !== true) {
        throw new Error(
          "sandbox-daytona: exec() requires commands.supportsMaxOutputBytes=true on " +
            "the injected SDK. The SandboxExecOptions contract guarantees a default " +
            "1 MB cap on stdout+stderr; without server-side enforcement the adapter " +
            "would buffer unbounded output before any cap could apply.",
        );
      }
      // Reject malformed caps fail-closed: a negative value would make
      // Uint8Array.slice keep almost the entire buffer; NaN/Infinity skip
      // the comparison entirely.
      if (
        options?.maxOutputBytes !== undefined &&
        (!Number.isInteger(options.maxOutputBytes) || options.maxOutputBytes < 0)
      ) {
        throw new Error(
          `sandbox-daytona: SandboxExecOptions.maxOutputBytes must be a non-negative ` +
            `integer; got ${String(options.maxOutputBytes)}.`,
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
      // Capability gate above guarantees server-side enforcement; the
      // contract default applies when the caller omits maxOutputBytes.
      const cap = options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

      const sdkOpts: DaytonaRunOpts = {
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(mergedEnv !== undefined ? { envs: mergedEnv } : {}),
        ...(mergedTimeout !== undefined ? { timeoutMs: mergedTimeout } : {}),
        ...(options?.onStdout !== undefined ? { onStdout: options.onStdout } : {}),
        ...(options?.onStderr !== undefined ? { onStderr: options.onStderr } : {}),
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
        maxOutputBytes: cap,
      };

      // Authoritative cancellation detection via Promise.race: SDK
      // resolution and abort observation compete at the same level so the
      // winner unambiguously identifies which event happened first.
      const sig = options?.signal;
      type SdkOutcome =
        | { readonly kind: "result"; readonly r: Awaited<ReturnType<typeof sdk.commands.run>> }
        | { readonly kind: "error"; readonly e: unknown };
      type Settled = SdkOutcome | { readonly kind: "abort" };
      // Build the abort observer BEFORE dispatching the SDK so any abort
      // that fires between the pre-aborted check and listener attach is
      // not silently lost. addEventListener does not replay past events,
      // so we also re-check `sig.aborted` synchronously after attach.
      const abortObserved: Promise<Settled> =
        sig === undefined
          ? new Promise<Settled>(() => {})
          : new Promise<Settled>((resolve) => {
              sig.addEventListener("abort", () => resolve({ kind: "abort" }), { once: true });
              if (sig.aborted) resolve({ kind: "abort" });
            });
      // Promise.try so a synchronous throw from a wrapper still flows
      // through the quarantine path below — without it, a sync throw
      // would escape exec() before quarantine could engage and the
      // remote command may already have been dispatched.
      const sdkPromise = Promise.try(() => sdk.commands.run(cmd, sdkOpts));
      const sdkSettled: Promise<SdkOutcome> = sdkPromise.then(
        (r): SdkOutcome => ({ kind: "result", r }),
        (e: unknown): SdkOutcome => ({ kind: "error", e }),
      );

      const winner: Settled = await Promise.race<Settled>([sdkSettled, abortObserved]);

      if (winner.kind === "abort") {
        // Bounded kill-confirmation wait — never hang forever on a
        // degraded provider. On timeout, quarantine the instance so
        // subsequent ops reject and operators can revoke out-of-band.
        // Inspect the settled SDK outcome: only a true cancellation
        // (AbortError or kill-style exit codes) maps to 130. A successful
        // completion landing just after the abort signal must be
        // propagated as success — replaying it would duplicate side effects.
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
          // Indeterminate remote state — original command may still be
          // running. Throw rather than return a normal-looking
          // SandboxAdapterResult so callers cannot mistake transport
          // uncertainty for an ordinary command failure and auto-retry
          // side-effecting work. Quarantine leaves destroy() callable.
          quarantined = true;
          throw new Error(
            `sandbox-daytona: abort timeout — SDK did not confirm remote termination ` +
              `within ${POST_ABORT_KILL_CONFIRM_MS}ms (after ${durationMs.toFixed(0)}ms ` +
              `total). Remote command state is INDETERMINATE; the original may still ` +
              `be running. Do NOT auto-retry this command — verify the workspace ` +
              `state out-of-band before re-running. Instance has been quarantined.`,
          );
        }
        const settled = confirmed.s;
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
          // Some other rejection arrived in the post-abort window —
          // remote state is INDETERMINATE. Throw so callers cannot
          // mistake this for a normal exit-1 failure and auto-retry.
          quarantined = true;
          const message = e instanceof Error ? e.message : String(e);
          throw new Error(
            "sandbox-daytona: SDK rejected after abort with non-AbortError; remote " +
              `command state is INDETERMINATE — instance quarantined: ${message}`,
            { cause: e },
          );
        }
        // SDK resolved with a result. Conventional kill exit codes
        // (130 SIGINT, 137 SIGKILL, 143 SIGTERM) confirm cancellation.
        // Anything else — including exit 0 — means the command actually
        // completed; propagate it so callers don't replay finished side
        // effects.
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
        // SDK rejected without a confirmed abort. Remote command state
        // is INDETERMINATE. Throw so callers cannot mistake transport
        // uncertainty for an ordinary command failure and auto-retry.
        // Quarantine still applies; destroy() remains callable.
        quarantined = true;
        const e = winner.e;
        const message = e instanceof Error ? e.message : String(e);
        throw new Error(
          "sandbox-daytona: SDK rejected; remote command state is INDETERMINATE — " +
            `instance quarantined (call destroy() to attempt cleanup): ${message}`,
          { cause: e },
        );
      }

      const result = winner.r;
      const durationMs = performance.now() - start;
      const capped = applyCombinedBudget(result.stdout, result.stderr, cap, result.truncated);
      const truncated = capped.truncated;
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
      const readBytes = sdk.files.readBytes;
      if (readBytes === undefined) {
        throw new Error(
          "sandbox-daytona: readFile requires sdk.files.readBytes for binary-safe reads. " +
            "Inject an SDK wrapper that exposes readBytes.",
        );
      }
      return runBoundedFileOp("readFile", path, () => readBytes(path));
    },

    writeFile: async (path: string, content: Uint8Array): Promise<void> => {
      ensureLive("writeFile");
      const writeBytes = sdk.files.writeBytes;
      if (writeBytes !== undefined) {
        await runBoundedFileOp("writeFile", path, () => writeBytes(path, content));
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
      await runBoundedFileOp("writeFile", path, () => sdk.files.write(path, text));
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
      // `delete` is required on DaytonaSdkSandbox; the runtime check is
      // defence-in-depth for JS callers that bypass the type contract.
      if (typeof sdk.delete !== "function") {
        throw new Error(
          "sandbox-daytona: destroy() requires sdk.delete to permanently delete the " +
            "remote workspace. The adapter never falls back to close() because in " +
            "several Daytona SDK versions it is a client-side detach that leaves the " +
            "workspace running and billable.",
        );
      }
      const TEARDOWN_TIMEOUT_MS = 10_000;
      destroyPending = (async () => {
        // Single-flight: reuse an existing in-flight delete from a prior
        // timed-out attempt. Issuing a second remote delete while the
        // first is still pending breaks coalescing — duplicate provider
        // mutations against a billable workspace, racy partial-failure
        // paths, idempotency-skew bugs.
        if (deleteInFlight === undefined) {
          // Call as a method so real SDK implementations that depend on
          // `this` get the correct receiver; copying into a local would
          // lose it.
          // Promise.try so a synchronous throw from sdk.delete() flows
          // through the quarantine + retry path rather than escaping
          // destroyPending half-set.
          const teardown = Promise.try(() => sdk.delete());
          const promise: Promise<DeleteOutcome> = teardown.then(
            (): DeleteOutcome => ({ kind: "ok" }),
            (e: unknown): DeleteOutcome => ({ kind: "err", e }),
          );
          deleteInFlight = promise;
          // Late convergence + cleanup. Runs regardless of whether the
          // current destroy() call has already returned. Guarded so a
          // late-arriving abandoned delete does not clobber a successor
          // delete that a retry has since started.
          promise.then((r) => {
            if (r.kind === "ok") {
              destroyed = true;
              quarantined = false;
            }
            if (deleteInFlight === promise) deleteInFlight = undefined;
          });
        }
        const inFlight = deleteInFlight;
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
            // Abandon the stuck in-flight delete. Concurrent callers
            // already coalesced through destroyPending — they are
            // awaiting THIS call's settlement, not racing the SDK
            // promise directly. After we throw, destroyPending clears
            // in finally{}; a serial retry sees deleteInFlight ===
            // undefined and issues a fresh sdk.delete() against a
            // possibly-recovering provider. The abandoned promise's
            // late-success handler stays attached, so if it eventually
            // resolves it still flips destroyed=true and clears
            // quarantine. Without this, a permanently hung provider
            // would strand the billable workspace until process restart.
            if (deleteInFlight === inFlight) deleteInFlight = undefined;
            quarantined = true;
            throw new Error(
              `sandbox-daytona: destroy() timed out after ${TEARDOWN_TIMEOUT_MS}ms — ` +
                "sdk.delete() did not settle within the local bound. The remote " +
                "workspace MAY still be running and billable; verify out-of-band. " +
                "Instance is quarantined. destroy() may be retried — a retry will " +
                "issue a fresh remote delete against a recovering provider.",
            );
          }
          // outcome.kind === "err". Teardown rejected — workspace
          // state is unknown. Quarantine so further exec/file ops
          // reject; destroy() remains retryable for recovery.
          quarantined = true;
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
