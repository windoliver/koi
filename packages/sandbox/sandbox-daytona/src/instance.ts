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
      const sdkPromise = sdk.commands.run(cmd, sdkOpts);
      const sig = options?.signal;
      type Settled =
        | { readonly kind: "result"; readonly r: Awaited<typeof sdkPromise> }
        | { readonly kind: "error"; readonly e: unknown }
        | { readonly kind: "abort" };
      const sdkSettled: Promise<Settled> = sdkPromise.then(
        (r): Settled => ({ kind: "result", r }),
        (e: unknown): Settled => ({ kind: "error", e }),
      );
      const abortObserved: Promise<Settled> =
        sig === undefined
          ? new Promise<Settled>(() => {})
          : new Promise<Settled>((resolve) => {
              sig.addEventListener("abort", () => resolve({ kind: "abort" }), { once: true });
            });

      const winner: Settled = await Promise.race([sdkSettled, abortObserved]);

      if (winner.kind === "abort") {
        // Bounded kill-confirmation wait — never hang forever on a
        // degraded provider. On timeout, quarantine the instance so
        // subsequent ops reject and operators can revoke out-of-band.
        const POST_ABORT_KILL_CONFIRM_MS = 5_000;
        const confirmed = await Promise.race([
          sdkSettled.then(() => "settled" as const),
          new Promise<"timeout">((resolve) =>
            setTimeout(() => resolve("timeout"), POST_ABORT_KILL_CONFIRM_MS),
          ),
        ]);
        const durationMs = performance.now() - start;
        if (confirmed === "timeout") {
          // Quarantine — leave destroy() callable so sdk.delete() can still
          // attempt the authoritative workspace deletion. Setting destroyed
          // would make destroy() a no-op and strand the billable workspace.
          quarantined = true;
          return {
            exitCode: 130,
            stdout: "",
            stderr:
              "sandbox-daytona: abort timeout — SDK did not confirm remote " +
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
        try {
          // Call as a method so real SDK implementations that depend on `this`
          // get the correct receiver; copying into a local would lose it.
          const outcome = await Promise.race([
            sdk.delete().then(
              () => ({ kind: "ok" as const }),
              (e: unknown) => ({ kind: "err" as const, e }),
            ),
            new Promise<{ kind: "timeout" }>((resolve) =>
              setTimeout(() => resolve({ kind: "timeout" }), TEARDOWN_TIMEOUT_MS),
            ),
          ]);
          if (outcome.kind === "ok") {
            destroyed = true;
            return;
          }
          if (outcome.kind === "timeout") {
            // Quarantine — workspace MAY still be running. Don't mark
            // destroyed; another retry might succeed once provider recovers.
            quarantined = true;
            throw new Error(
              `sandbox-daytona: destroy() timed out after ${TEARDOWN_TIMEOUT_MS}ms — ` +
                "sdk.delete() did not settle. The remote workspace MAY still be running " +
                "and billable; verify out-of-band. Instance is quarantined; destroy() " +
                "may be retried.",
            );
          }
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
