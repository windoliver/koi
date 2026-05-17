/**
 * Subprocess-based SandboxExecutor implementation.
 *
 * Spawns a child Bun process running subprocess-runner.ts (dev) or
 * subprocess-runner.js (after build) to execute arbitrary code in isolation.
 *
 * Protocol:
 *   argv[2] = absolute path to code file (temp or entry from context)
 *   argv[3] = JSON-encoded input
 *   fd 3    = __KOI_RESULT__\n<json>\n  (framed protocol output)
 *
 * Isolation note (fail-closed, explicit-deny):
 *   This executor uses EXPLICIT-DENY semantics for network and resource isolation.
 *   When the caller supplies an ExecutionContext, the executor refuses to
 *   proceed when the caller EXPLICITLY requests isolation that this package
 *   cannot enforce on its own.
 *
 *   The guard fires whenever:
 *     - context.networkAllowed === false — explicit network-deny requested; this
 *       package cannot enforce it without OS-level support (@koi/sandbox-os)
 *     - context.resourceLimits !== undefined — resource limits require OS-level
 *       enforcement (cgroups, rlimits) unavailable in plain subprocess mode
 *     - context.filesystem !== undefined — filesystem allowlists require a
 *       filesystem-confining backend unavailable in plain subprocess mode
 *
 *   Omitting networkAllowed (undefined) means "caller has no isolation opinion" —
 *   the executor passes through without complaint. ExecutionContext is also used
 *   by callers for non-isolation purposes (workspacePath, entryPath, env) and
 *   those fields are always honoured and never trigger the guard.
 *
 *   To avoid the guard, callers must omit networkAllowed=false, resourceLimits,
 *   and filesystem allowlists. Plain subprocess execution is only suitable for
 *   unconfined/trusted code or metadata-only ExecutionContext fields.
 *
 *   Historically this config accepted externalIsolation/filesystemIsolation
 *   booleans as caller assertions. Those are kept as source-compatible no-ops;
 *   a plain subprocess cannot verify or provide confinement, so it must not
 *   treat caller assertions as enforcement proof.
 *
 *   B) Omit networkAllowed and resourceLimits — passes through with no enforcement
 *      (caller takes responsibility for running unconfined).
 *
 * Output cap note (drain-not-kill):
 *   When either stream hits the output cap, the reader stops accumulating bytes
 *   but continues draining the underlying pipe silently. This prevents the child
 *   from blocking on a full pipe buffer (which would cause a false TIMEOUT) while
 *   also preventing host OOM. The child is NOT killed on cap; only on timeout.
 *
 *   Caveat: if stdout or stderr is truncated AND the stderr framing marker was past
 *   the cap, the run is classified as CRASH (marker missing) after the child exits
 *   naturally. This is intentional — reserving marker space is more complex.
 *
 * Process-group kill note:
 *   When `setsid` is available (Linux/macOS), the child is spawned as a new
 *   session leader so that killing -proc.pid (negative) sends SIGKILL to the
 *   entire process group, including grandchildren. On environments where setsid
 *   is not on PATH (Windows, minimal containers), descendant cleanup is
 *   best-effort: only the direct Bun child is killed.
 *   TODO: explore Bun.spawn's posix_spawn flags as an alternative when available.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExecutionContext,
  SandboxError,
  SandboxErrorCode,
  SandboxExecutor,
  SandboxResult,
} from "@koi/core/sandbox-executor";

/** Framing marker emitted by subprocess-runner on stderr. */
const RESULT_MARKER = "__KOI_RESULT__\n";

/**
 * Allowlist of host env vars that are safe to pass into the sandbox child.
 * All other host env vars (credentials, tokens, etc.) are scrubbed.
 */
const SAFE_ENV_KEYS: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  "NODE_ENV",
  "BUN_INSTALL",
  "LANG",
  "LC_ALL",
];

/** Default maximum output bytes read from stderr (10 MiB). */
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Default bun executable name. */
const DEFAULT_BUN_PATH = "bun";

export interface SubprocessExecutorConfig {
  readonly bunPath?: string;
  readonly maxOutputBytes?: number;
  readonly cwd?: string;
  /**
   * Deprecated source-compatible no-op. Plain subprocess execution cannot
   * verify external confinement, so restricted ExecutionContext fields are
   * always refused regardless of this value.
   */
  readonly externalIsolation?: boolean;
  /**
   * Deprecated source-compatible no-op. Filesystem allowlists are always
   * refused by this executor because it cannot enforce them.
   */
  readonly filesystemIsolation?: boolean;
  /**
   * When true (default), the executor refuses to run if process-group isolation
   * via `setsid` is unavailable on PATH. This prevents silent leakage of grandchild
   * processes after timeout — without process-group kill, only the direct Bun child
   * is SIGKILLed; grandchildren (e.g., spawned by user code) keep running.
   *
   * Set to false to opt out (e.g., trusted code where descendant cleanup is not a
   * concern, or environments like Windows / minimal containers where setsid is absent
   * by design).
   *
   * Default: true (fail-closed).
   */
  readonly requireProcessGroupIsolation?: boolean;
  /**
   * Dependency-injection override for setsid resolution.
   * When provided, this function is called instead of the real `resolveSetsid()`.
   * Useful in tests to simulate setsid absence without PATH manipulation.
   */
  readonly resolveSetsid?: () => string | null;
}

/** Resolve the runner script path relative to this file's location. */
function resolveRunnerPath(): string {
  const here = import.meta.dir;
  const ext = here.endsWith("dist") ? "subprocess-runner.js" : "subprocess-runner.ts";
  return join(here, ext);
}

/** Write code to a temp file and return its path and the temp dir. */
function writeCodeToTemp(code: string): { readonly codePath: string; readonly tempDir: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "koi-sandbox-"));
  const codePath = join(tempDir, "code.ts");
  writeFileSync(codePath, code, "utf8");
  return { codePath, tempDir };
}

/** Clean up temp dir, ignoring errors. */
function cleanupTemp(tempDir: string): void {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch (_: unknown) {
    // best-effort cleanup — ignore errors
  }
}

/** Parse the framed result from stderr text. Returns undefined if marker absent. */
function parseFramedResult(stderrText: string): unknown {
  const markerIdx = stderrText.lastIndexOf(RESULT_MARKER);
  if (markerIdx === -1) return undefined;
  const jsonStart = markerIdx + RESULT_MARKER.length;
  const jsonText = stderrText.slice(jsonStart).trimEnd();
  try {
    return JSON.parse(jsonText);
  } catch (_: unknown) {
    return undefined;
  }
}

/**
 * Type-predicate: checks that v is a non-null object with an "ok" field,
 * plus optional "output" and "error" fields — the framed result shape.
 * Avoids `as` casts when narrowing the raw JSON parse result.
 */
function isFramedObject(
  v: unknown,
): v is { readonly ok: unknown; readonly output?: unknown; readonly error?: unknown } {
  return v !== null && typeof v === "object" && "ok" in v;
}

/** Classify a killed process exit into a SandboxErrorCode. */
function classifyKilledCode(timerFired: boolean, exitCode: number): SandboxErrorCode {
  if (timerFired) return "TIMEOUT";
  // exitCode 137 = SIGKILL from outside (e.g. OOM killer), -9 = Bun internal
  if (exitCode === 137 || exitCode === -9) return "OOM";
  return "CRASH";
}

/**
 * Build a sanitized child env:
 * 1. Start with {}.
 * 2. Copy from process.env only the keys in SAFE_ENV_KEYS (skip undefined values).
 * 3. Layer in KOI_* signal vars from context.
 * 4. Merge context.env if present (caller-provided wins).
 */
function buildChildEnv(context?: ExecutionContext): Readonly<Record<string, string>> {
  // `let` justified: env is built incrementally in three layers
  const env: Record<string, string> = {};

  // Layer 1: safe host env vars only
  for (const key of SAFE_ENV_KEYS) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }

  // Layer 2: KOI signal vars from context
  if (context !== undefined) {
    if (context.networkAllowed === false) {
      // Signal: caller requested no network. Real enforcement needs @koi/sandbox-os.
      env.KOI_NETWORK_ALLOWED = "0";
    }
    if (context.resourceLimits !== undefined) {
      // Informational: real enforcement is OS-level (requires @koi/sandbox-os).
      if (context.resourceLimits.maxMemoryMb !== undefined) {
        env.KOI_MAX_MEMORY_MB = String(context.resourceLimits.maxMemoryMb);
      }
      if (context.resourceLimits.maxPids !== undefined) {
        env.KOI_MAX_PIDS = String(context.resourceLimits.maxPids);
      }
      if (context.resourceLimits.maxOpenFiles !== undefined) {
        env.KOI_MAX_OPEN_FILES = String(context.resourceLimits.maxOpenFiles);
      }
    }
    if (context.filesystem !== undefined) {
      if (context.filesystem.read !== undefined) {
        env.KOI_FILESYSTEM_READ_ALLOWLIST = JSON.stringify(context.filesystem.read);
      }
      if (context.filesystem.write !== undefined) {
        env.KOI_FILESYSTEM_WRITE_ALLOWLIST = JSON.stringify(context.filesystem.write);
      }
    }

    // Layer 4: caller-provided env (wins over all earlier layers).
    // No allowlist filter — caller explicitly opted in by populating this field.
    if (context.env !== undefined) {
      for (const [k, v] of Object.entries(context.env)) {
        env[k] = v;
      }
    }
  }

  return env;
}

/**
 * Read from a ReadableStream<Uint8Array> up to maxBytes, then drain silently.
 * Returns the decoded text, a truncated flag, and an optional tail buffer.
 *
 * When the cap is hit we STOP accumulating head bytes but KEEP draining the pipe.
 * Draining prevents the child from blocking on a full pipe buffer (which would
 * turn into a false TIMEOUT). The child is NOT killed here — only the timeout
 * timer kills the child.
 *
 * When tailBytes > 0, a sliding tail buffer is maintained that always holds the
 * last ~tailBytes characters of the stream. This allows the caller to search for
 * the framing marker (which appears at the END of stderr) even when the total
 * output exceeded maxBytes and the head was truncated.
 *
 * The tail is returned as a separate string so the caller can try parsing from
 * it when the head parse fails and truncated=true.
 */
async function readBoundedText(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  tailBytes = 0,
): Promise<{ readonly text: string; readonly truncated: boolean; readonly tail: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  // `let` justified: buf/total/truncated/tailBuf are accumulated across iterations
  let total = 0;
  let truncated = false;
  let buf = "";
  // `let` justified: tailBuf is a sliding window updated on every chunk
  let tailBuf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    const chunk = truncated
      ? decoder.decode(value, { stream: true }) // still decode for tail — don't use stream:true for head
      : (() => {
          const remaining = maxBytes - total;
          if (remaining <= 0) {
            truncated = true;
            return decoder.decode(value, { stream: true });
          }
          if (value.byteLength > remaining) {
            buf += decoder.decode(value.subarray(0, remaining), { stream: true });
            total += remaining;
            truncated = true;
            // decode the rest for tail tracking
            return decoder.decode(value.subarray(remaining), { stream: true });
          }
          const decoded = decoder.decode(value, { stream: true });
          buf += decoded;
          total += value.byteLength;
          return decoded;
        })();
    if (tailBytes > 0) {
      tailBuf += chunk;
      if (tailBuf.length > tailBytes) {
        tailBuf = tailBuf.slice(tailBuf.length - tailBytes);
      }
    }
  }
  // Flush the decoder.
  const flushed = decoder.decode();
  if (!truncated) buf += flushed;
  if (tailBytes > 0 && flushed.length > 0) {
    tailBuf += flushed;
    if (tailBuf.length > tailBytes) {
      tailBuf = tailBuf.slice(tailBuf.length - tailBytes);
    }
  }
  return { text: buf, truncated, tail: tailBuf };
}

export function protocolStreamFromExtraPipe(raw: unknown): ReadableStream<Uint8Array> | undefined {
  if (typeof raw === "number") return Bun.file(raw).stream();
  if (raw instanceof ReadableStream) return raw as ReadableStream<Uint8Array>;
  return undefined;
}

// ---------------------------------------------------------------------------
// Process-group kill (Fix 2)
//
// setsid availability is probed once lazily at first spawn.
// `let` justified: lazily populated on first use.
// ---------------------------------------------------------------------------

/** Cached result of setsid availability probe. undefined = not yet checked. */
let _setsidPath: string | null | undefined;

/** Lazily resolve the path to `setsid`, or null if unavailable. */
function resolveSetsid(): string | null {
  if (_setsidPath !== undefined) return _setsidPath;
  try {
    const r = Bun.spawnSync(["which", "setsid"], { stdout: "pipe", stderr: "ignore" });
    if (r.exitCode === 0 && r.stdout !== null) {
      // Convert Buffer to Uint8Array for TextDecoder compatibility under strict TS6.
      const bytes = new Uint8Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength);
      const path = new TextDecoder().decode(bytes).trim();
      _setsidPath = path.length > 0 ? path : null;
    } else {
      _setsidPath = null;
    }
  } catch (_: unknown) {
    _setsidPath = null;
  }
  return _setsidPath;
}

/**
 * Kill the child process and, when setsid was used, the entire process group.
 * Falls back to direct proc.kill(9) if group-kill fails or setsid was absent.
 */
function killChild(
  proc: { readonly pid?: number; readonly kill: (signal?: number) => void },
  usedSetsid: boolean,
): void {
  if (usedSetsid && proc.pid !== undefined) {
    try {
      // Negative PID = send signal to the whole process group.
      process.kill(-proc.pid, "SIGKILL");
      return;
    } catch (_: unknown) {
      // Group kill failed — fall through to direct kill.
    }
  }
  proc.kill(9);
}

type ExecuteResult =
  | { readonly ok: true; readonly value: SandboxResult }
  | { readonly ok: false; readonly error: SandboxError };

export function createSubprocessExecutor(config?: SubprocessExecutorConfig): SandboxExecutor {
  const bunPath = config?.bunPath ?? DEFAULT_BUN_PATH;
  const maxOutputBytes = config?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const cwdOverride = config?.cwd;
  // Default true: fail closed when setsid is unavailable, preventing silent grandchild leaks.
  const requirePGI = config?.requireProcessGroupIsolation !== false;
  // Allow DI override for testing; fall back to the real probe.
  const resolveSetsidFn = config?.resolveSetsid ?? resolveSetsid;

  const runnerPath = resolveRunnerPath();

  return {
    execute: async (
      code: string,
      input: unknown,
      timeoutMs: number,
      context?: ExecutionContext,
    ): Promise<ExecuteResult> => {
      // Explicit-deny guard: refuse execution when the caller explicitly requests
      // isolation that this package cannot enforce on its own.
      //
      // Semantics:
      //   - context.networkAllowed === false — explicit network-deny; enforce requires
      //     OS-level support (@koi/sandbox-os). Omitting networkAllowed (undefined)
      //     means "caller has no isolation opinion" — pass through.
      //   - context.resourceLimits !== undefined — resource limits require OS-level
      //     enforcement (cgroups, rlimits) unavailable in plain subprocess mode.
      //   - context.filesystem !== undefined — filesystem allowlists require a
      //     filesystem-confining backend, not just child env hints.
      //
      // ExecutionContext is also used for non-isolation metadata (workspacePath,
      // entryPath, env). Those fields never trigger the guard.
      //
      if (context !== undefined) {
        const wantsRestricted =
          context.networkAllowed === false ||
          context.resourceLimits !== undefined ||
          context.filesystem !== undefined;
        if (wantsRestricted) {
          const error: SandboxError = {
            code: "PERMISSION",
            message:
              "subprocess-executor cannot enforce network/resource/filesystem isolation; use a sandbox executor backed by a real confining backend",
            durationMs: 0,
          };
          return { ok: false, error };
        }
      }

      // If context.entryPath is set, use it directly without writing a temp file.
      // A temp dir is still created for cleanup symmetry but left empty.
      const hasTempCode = context?.entryPath === undefined;
      const { codePath, tempDir } = hasTempCode
        ? writeCodeToTemp(code)
        : { codePath: context.entryPath, tempDir: mkdtempSync(join(tmpdir(), "koi-sandbox-")) };

      const start = Date.now();

      try {
        // Determine working directory: per-invocation context wins over config-level cwd.
        const cwd = context?.workspacePath ?? cwdOverride;

        // Always build a sanitized child env — never inherit parent's full process.env.
        const childEnv = buildChildEnv(context);

        // Wrap child in setsid when available so we can kill the entire process
        // group (including grandchildren) via process.kill(-pid, "SIGKILL").
        const setsidPath = resolveSetsidFn();

        // Fail-closed: when requireProcessGroupIsolation is true (default) and setsid
        // is unavailable, refuse to execute. Without setsid, grandchild processes
        // spawned by user code survive the SIGKILL timeout, leaking silently.
        // Callers can opt out by passing requireProcessGroupIsolation: false.
        if (requirePGI && setsidPath === null) {
          const error: SandboxError = {
            code: "PERMISSION",
            message:
              "subprocess-executor requires setsid for process-group isolation, but it is not available on PATH; pass requireProcessGroupIsolation:false to opt out (descendant processes may leak after timeout)",
            durationMs: 0,
          };
          return { ok: false, error };
        }

        const usedSetsid = setsidPath !== null;
        const cmd = usedSetsid
          ? [setsidPath, bunPath, "run", runnerPath, codePath, JSON.stringify(input ?? null)]
          : [bunPath, "run", runnerPath, codePath, JSON.stringify(input ?? null)];

        // fd=3 is a dedicated protocol pipe — the runner emits the framing
        // marker there so user code on stdout/stderr cannot race it. Eliminates
        // the CI flake where a tight `process.stderr.write` burst overruns a
        // stderr-side marker on slow runners.
        const spawnOpts = {
          // [stdin, stdout, stderr, fd3] — Bun's stdio array form.
          // Mutable tuple required by Bun's SpawnOptions; the values are still
          // validated at spawn-time.
          stdio: ["ignore", "pipe", "pipe", "pipe"] as ["ignore", "pipe", "pipe", "pipe"],
          ...(cwd !== undefined ? { cwd } : {}),
          env: childEnv,
        };

        const proc = Bun.spawn(cmd, spawnOpts);

        // Kill the process (group) after timeout.
        // `let` justified: `timedOut` is a mutable flag set inside the timer callback.
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          killChild(proc, usedSetsid);
        }, timeoutMs);

        // Bun's Timer type does not expose `unref` in its declared types but the
        // underlying object supports it at runtime — check defensively.
        if ("unref" in timer && typeof timer.unref === "function") timer.unref();

        // Start bounded drain readers BEFORE awaiting exit — they must run concurrently
        // to prevent pipe-buffer deadlock (chatty child fills the pipe → deadlock if we
        // await proc.exited first without draining). Both streams are capped at
        // maxOutputBytes; excess bytes are discarded silently (pipe stays drained).
        //
        // Stderr uses a 64 KB tail buffer so the framing marker (which appears at
        // the END of stderr) can be recovered even when total stderr exceeded maxOutputBytes.
        // Stdout does not need a tail — we only care about the head for diagnostics.
        const STDERR_TAIL_BYTES = 64 * 1024;
        const stdoutP = readBoundedText(proc.stdout, maxOutputBytes);
        const stderrP = readBoundedText(proc.stderr, maxOutputBytes, STDERR_TAIL_BYTES);
        // fd=3 carries only the framed result (RESULT_MARKER + JSON). Cap is
        // small — payloads are bounded by JSON.stringify of the user's return
        // value; 256 KB is generous and prevents pathological growth from
        // infecting parent memory.
        const FD3_MAX_BYTES = 256 * 1024;
        // Bun may expose fd=3 either as a raw fd number or as a ReadableStream,
        // depending on runtime version. Coerce either shape to one stream; if
        // fd=3 is missing, the parser falls back to scanning stderr.
        const fd3Raw = (proc as unknown as { readonly stdio?: readonly unknown[] }).stdio?.[3];
        const fd3Stream = protocolStreamFromExtraPipe(fd3Raw);
        const fd3P =
          fd3Stream !== undefined
            ? readBoundedText(fd3Stream, FD3_MAX_BYTES)
            : Promise.resolve({ text: "", truncated: false, tail: "" } as const);

        // Await child exit FIRST so the timer is cleared as soon as the child exits —
        // post-exit drain time does not count against the deadline. If the timer fired
        // before the child exited, timedOut will already be true.
        const exitCode = await proc.exited;
        clearTimeout(timer);

        // Drain both pipes (they are already closed after child exit — this just
        // consumes any buffered bytes and resolves the reader promises).
        const [, stderrResult, fd3Result] = await Promise.all([stdoutP, stderrP, fd3P]);

        const durationMs = Date.now() - start;

        // Killed or OOM
        if (timedOut || exitCode === 137 || exitCode === -9) {
          const errorCode: SandboxErrorCode = classifyKilledCode(timedOut, exitCode ?? -1);
          const error: SandboxError = {
            code: errorCode,
            message:
              errorCode === "TIMEOUT"
                ? "Sandbox execution timed out"
                : "Sandbox process killed (OOM or signal)",
            durationMs,
          };
          return { ok: false, error };
        }

        // Search for the framing marker. Preferred channel is fd=3 — a
        // dedicated pipe the runner writes only the marker+JSON to, so user
        // code on stdout/stderr cannot interleave with it. Falls back to
        // stderr (head, then tail when truncated) for backward compat with
        // older runners or direct-exec scenarios where fd=3 is unavailable.
        const framed =
          parseFramedResult(fd3Result.text) ??
          parseFramedResult(stderrResult.text) ??
          (stderrResult.truncated ? parseFramedResult(stderrResult.tail) : undefined);

        if (framed === undefined) {
          const snippet = stderrResult.truncated
            ? `${stderrResult.tail.slice(-2000)} [truncated — marker not found in head or tail]`
            : stderrResult.text.slice(-2000).slice(0, maxOutputBytes);
          const message = stderrResult.truncated
            ? "Sandbox stderr exceeded output limit; result marker not found in head or tail"
            : "Sandbox exited without result marker";
          const error: SandboxError = {
            code: "CRASH",
            message,
            durationMs,
            stack: snippet,
          };
          return { ok: false, error };
        }

        if (!isFramedObject(framed)) {
          const error: SandboxError = {
            code: "CRASH",
            message: "Sandbox result marker contained invalid JSON",
            durationMs,
          };
          return { ok: false, error };
        }

        if (framed.ok === false) {
          const errMsg = typeof framed.error === "string" ? framed.error : "Unknown sandbox error";
          const error: SandboxError = {
            code: "CRASH",
            message: errMsg,
            durationMs,
          };
          return { ok: false, error };
        }

        const value: SandboxResult = {
          output: framed.output,
          durationMs,
        };
        return { ok: true, value };
      } finally {
        // Always remove temp dir, even if spawn or stderr read throws.
        cleanupTemp(tempDir);
      }
    },
  };
}
