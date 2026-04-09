import type {
  KoiError,
  Result,
  SandboxAdapter,
  SandboxAdapterResult,
  SandboxExecOptions,
  SandboxInstance,
  SandboxProfile,
} from "@koi/core";

import {
  detectPlatform,
  type PlatformInfo,
  type SandboxErrorCode,
  type SandboxPlatform,
} from "./detect.js";
import {
  buildBwrapPrefix,
  buildBwrapSuffix,
  buildSystemdRunArgs,
  ensureDenyReadPaths,
} from "./platform/bwrap.js";
import { buildSeatbeltPrefix, generateSeatbeltProfile } from "./platform/seatbelt.js";
import { validateProfile } from "./validate.js";

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576; // 1 MB — matches @koi/middleware-sandbox default

// Module-level cache — systemd-run --user requires an active D-Bus user session.
// Bun.which() only checks PATH; this probe verifies the user session is reachable.
let cachedSystemdRunUserAvailable: boolean | undefined;

/**
 * Probe whether `systemd-run --user --scope` can create a transient scope.
 * Returns false if the binary is absent, D-Bus is unavailable (CI/container),
 * or the user session is not running.
 * Result is cached — the session doesn't change while the process is running.
 */
function probeSystemdRunUser(): boolean {
  if (cachedSystemdRunUserAvailable !== undefined) return cachedSystemdRunUserAvailable;
  if (Bun.which("systemd-run") === null) {
    cachedSystemdRunUserAvailable = false;
    return false;
  }
  try {
    const proc = Bun.spawnSync(["systemd-run", "--user", "--scope", "--", "true"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    cachedSystemdRunUserAvailable = proc.exitCode === 0;
  } catch {
    cachedSystemdRunUserAvailable = false;
  }
  return cachedSystemdRunUserAvailable;
}

/** `SandboxAdapter` (L0) extended with OS-level platform metadata. */
export interface SandboxOsAdapter extends SandboxAdapter {
  readonly platform: PlatformInfo;
}

function validationError(message: string, sandboxCode?: SandboxErrorCode): Result<never, KoiError> {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: false,
      ...(sandboxCode !== undefined ? { context: { sandboxCode } } : {}),
    },
  };
}

function missingBinaryMessage(platform: SandboxPlatform): string {
  return platform === "seatbelt"
    ? "Binary 'sandbox-exec' not found in PATH"
    : "Binary 'bwrap' not found in PATH";
}

function missingBinaryCode(platform: SandboxPlatform): SandboxErrorCode {
  return platform === "seatbelt" ? "SEATBELT_NOT_FOUND" : "BWRAP_NOT_FOUND";
}

/** Shared mutable byte budget across stdout + stderr to enforce a combined cap. */
interface ByteBudget {
  remaining: number;
}

/**
 * Stream a ReadableStream into a string, drawing from a shared ByteBudget.
 * Truncates when the shared budget is exhausted, enforcing a combined cap.
 * Calls onChunk for each decoded text chunk before truncation.
 */
export async function collectStream(
  stream: ReadableStream<Uint8Array>,
  budget: ByteBudget,
  onChunk?: (chunk: string) => void,
): Promise<{ text: string; truncated: boolean }> {
  // One decoder per stream — shared TextDecoder state corrupts multi-byte sequences
  // when stdout and stderr are decoded concurrently.
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = "";
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (budget.remaining <= 0) {
        // Budget exhausted — mark truncated but keep draining to prevent pipe-full deadlock.
        // A child blocked on write() will never exit if we stop reading.
        truncated = true;
        continue;
      }
      const chunk = value.length <= budget.remaining ? value : value.slice(0, budget.remaining);
      const chunkText = decoder.decode(chunk, { stream: true });
      text += chunkText;
      budget.remaining -= chunk.length;
      onChunk?.(chunkText);
      if (value.length > chunk.length) {
        // This chunk exhausted the budget; mark truncated and keep draining.
        truncated = true;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { text, truncated };
}

/**
 * Build an effective AbortSignal combining an optional caller signal with
 * an optional per-exec timeout. Returns [signal, cleanup] — always call cleanup().
 * Sets timedOutRef.value = true when the internal timeout fires.
 */
function buildExecSignal(
  opts: SandboxExecOptions | undefined,
  timedOutRef: { value: boolean },
): [AbortSignal | undefined, () => void] {
  const signals: AbortSignal[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (opts?.signal !== undefined) signals.push(opts.signal);

  if (opts?.timeoutMs !== undefined) {
    const controller = new AbortController();
    timer = setTimeout(() => {
      timedOutRef.value = true;
      controller.abort();
    }, opts.timeoutMs);
    signals.push(controller.signal);
  }

  const cleanup = (): void => {
    if (timer !== undefined) clearTimeout(timer);
  };

  if (signals.length === 0) return [undefined, cleanup];
  if (signals.length === 1) return [signals[0], cleanup];
  return [AbortSignal.any(signals), cleanup];
}

/**
 * Create a SandboxInstance backed by the given platform and pre-validated profile.
 * Conforms to the L0 SandboxInstance contract: exec() returns Promise<SandboxAdapterResult>.
 */
function createInstance(
  platform: SandboxPlatform,
  profile: SandboxProfile,
  systemdRunAvailable: boolean,
): SandboxInstance {
  // Ensure denyRead mount points exist before bwrap tries to overlay them.
  // bwrap cannot create missing directories on a ro-bound root.
  if (platform === "bwrap") {
    ensureDenyReadPaths(profile);
  }

  // Pre-compute profile-constant prefix once at create() time
  const commandPrefix =
    platform === "seatbelt"
      ? buildSeatbeltPrefix(generateSeatbeltProfile(profile))
      : buildBwrapPrefix(profile);

  // Whether each exec() invocation should use a named systemd transient scope.
  // Using a named unit lets the abort handler stop the scope explicitly,
  // preventing leaks when proc.kill() only signals the wrapper PID.
  const needsSystemdRun =
    platform === "bwrap" && systemdRunAvailable && buildSystemdRunArgs(profile) !== null;

  return {
    async exec(
      command: string,
      args: readonly string[],
      opts?: SandboxExecOptions,
    ): Promise<SandboxAdapterResult> {
      const bwrapArgs =
        platform === "seatbelt"
          ? [...commandPrefix, command, ...args]
          : [...commandPrefix, ...buildBwrapSuffix(profile, command, args)];

      // Generate a unique unit name per exec so we can stop the scope on abort.
      const execUnitName = needsSystemdRun
        ? `koi-sb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
        : undefined;
      const systemdExecArgs =
        execUnitName !== undefined ? buildSystemdRunArgs(profile, execUnitName) : null;
      const argv = systemdExecArgs !== null ? [...systemdExecArgs, ...bwrapArgs] : bwrapArgs;

      const maxBytes = opts?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const start = Date.now();
      const timedOutRef = { value: false };
      // sentSigkillRef tracks whether WE sent SIGKILL (escalation), so we don't
      // misclassify our own escalation kill as an OOM event.
      const sentSigkillRef = { value: false };
      // Profile-level timeout as fallback; per-call opts.timeoutMs takes precedence.
      const resolvedTimeoutMs = opts?.timeoutMs ?? profile.resources.timeoutMs;
      const effectiveOpts =
        resolvedTimeoutMs !== undefined ? { ...opts, timeoutMs: resolvedTimeoutMs } : opts;
      const [effectiveSignal, cleanupSignal] = buildExecSignal(effectiveOpts, timedOutRef);

      // systemd-run --user requires access to the D-Bus user session, which
      // is signalled via XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS.
      // SAFE_ENV (passed by execSandboxed) strips these, so we must re-inject
      // them from the outer process when a systemd-run prefix is active.
      // These variables are only used by systemd-run itself — bwrap's
      // --clearenv still controls the sandbox's interior environment.
      let spawnEnv = opts?.env;
      if (execUnitName !== undefined && opts?.env !== undefined) {
        const busEnv: Record<string, string> = {};
        if (process.env.XDG_RUNTIME_DIR !== undefined) {
          busEnv.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
        }
        if (process.env.DBUS_SESSION_BUS_ADDRESS !== undefined) {
          busEnv.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS;
        }
        spawnEnv = { ...opts.env, ...busEnv };
      }

      const spawnOpts: Parameters<typeof Bun.spawn>[1] = {
        stdout: "pipe",
        stderr: "pipe",
        ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(spawnEnv !== undefined ? { env: spawnEnv } : {}),
        ...(opts?.stdin !== undefined ? { stdin: new TextEncoder().encode(opts.stdin) } : {}),
      };

      const proc = Bun.spawn(argv, spawnOpts);

      // Check immediately after spawn — signal may have been aborted before or during spawn.
      if (effectiveSignal?.aborted === true) {
        proc.kill();
      }

      let sigkillEscalationTimer: ReturnType<typeof setTimeout> | undefined;

      const abortHandler = (): void => {
        proc.kill(); // SIGTERM — ask the process to exit gracefully
        // Stop the named systemd scope so all child processes inside the cgroup
        // are terminated. proc.kill() only signals the bwrap wrapper PID;
        // grandchild processes survive unless the cgroup scope is stopped.
        if (execUnitName !== undefined) {
          try {
            Bun.spawnSync(["systemctl", "--user", "stop", execUnitName], {
              stdout: "ignore",
              stderr: "ignore",
            });
          } catch {
            // systemd-run may not be available or unit may have already exited.
          }
        }
        // Escalate to SIGKILL after 2 s if bwrap hasn't exited.
        // bwrap almost always exits immediately on SIGTERM, but if it hangs
        // (rare: blocked in kernel during mount teardown), this prevents a
        // permanent hang on proc.exited.
        sigkillEscalationTimer = setTimeout(() => {
          sentSigkillRef.value = true;
          try {
            proc.kill(9);
          } catch {
            // Process already exited — ignore.
          }
        }, 2_000);
        // Cancel the escalation timer if the process exits before 2 s.
        void proc.exited.then(() => {
          if (sigkillEscalationTimer !== undefined) clearTimeout(sigkillEscalationTimer);
        });
      };
      effectiveSignal?.addEventListener("abort", abortHandler, { once: true });

      // Narrow stream types — guaranteed by stdout/stderr: "pipe"
      const stdoutStream = proc.stdout;
      const stderrStream = proc.stderr;
      if (!(stdoutStream instanceof ReadableStream) || !(stderrStream instanceof ReadableStream)) {
        throw new Error("Bun.spawn must return ReadableStream when stdout/stderr is 'pipe'");
      }

      const budget: ByteBudget = { remaining: maxBytes };
      const [stdoutResult, stderrResult, exitCode] = await Promise.all([
        collectStream(stdoutStream, budget, opts?.onStdout),
        collectStream(stderrStream, budget, opts?.onStderr),
        proc.exited,
      ]);

      effectiveSignal?.removeEventListener("abort", abortHandler);
      cleanupSignal();
      if (sigkillEscalationTimer !== undefined) clearTimeout(sigkillEscalationTimer);

      const truncated = stdoutResult.truncated || stderrResult.truncated;
      const rawSignal = proc.signalCode != null ? String(proc.signalCode) : undefined;

      // OOM heuristic: cgroup v2 kills processes with SIGKILL when memory.max is exceeded.
      // Distinguish OOM from our own escalation kill (sentSigkillRef) and from timeouts.
      const oomKilled = rawSignal === "SIGKILL" && !timedOutRef.value && !sentSigkillRef.value;

      return {
        exitCode,
        stdout: stdoutResult.text,
        stderr: stderrResult.text,
        durationMs: Date.now() - start,
        timedOut: timedOutRef.value,
        oomKilled,
        ...(truncated ? { truncated } : {}),
        ...(rawSignal !== undefined ? { signal: rawSignal } : {}),
      };
    },
    async readFile(_path: string): Promise<Uint8Array> {
      throw new Error("readFile not implemented — use @koi/nexus-fuse-mount for virtual FS");
    },
    async writeFile(_path: string, _data: Uint8Array): Promise<void> {
      throw new Error("writeFile not implemented — use @koi/nexus-fuse-mount for virtual FS");
    },
    async destroy(): Promise<void> {},
  };
}

export function createOsAdapter(): Result<SandboxOsAdapter, KoiError> {
  const detected = detectPlatform();
  if (!detected.ok) return detected;

  const platform = detected.value;
  const binaryName = platform === "seatbelt" ? "sandbox-exec" : "bwrap";
  const available = Bun.which(binaryName);
  if (available === null) {
    return validationError(missingBinaryMessage(platform), missingBinaryCode(platform));
  }

  const systemdRunAvailable = platform === "bwrap" ? probeSystemdRunUser() : false;

  return {
    ok: true,
    value: createOsAdapterForTest({
      platform,
      available: true,
      systemdRunAvailable,
    }),
  };
}

export function createOsAdapterForTest(opts: {
  readonly platform: SandboxPlatform;
  readonly available: boolean;
  readonly systemdRunAvailable?: boolean;
}): SandboxOsAdapter {
  return {
    name: "@koi/sandbox-os",
    platform: {
      platform: opts.platform,
      available: opts.available,
      ...(opts.available ? {} : { reason: missingBinaryMessage(opts.platform) }),
    },
    async create(profile: SandboxProfile): Promise<SandboxInstance> {
      const validated = validateProfile(profile, opts.platform);
      if (!validated.ok) {
        throw new Error(validated.error.message, { cause: validated.error });
      }

      const systemdRunAvailable = opts.systemdRunAvailable ?? false;

      // When maxMemoryMb is set but systemd-run is unavailable, cgroup v2 enforcement
      // is not possible. Fail loudly rather than silently ignoring the limit.
      if (
        opts.platform === "bwrap" &&
        validated.value.resources.maxMemoryMb !== undefined &&
        !systemdRunAvailable
      ) {
        throw new Error(
          "SandboxProfile.resources.maxMemoryMb requires systemd-run for cgroup v2 enforcement, " +
            "but 'systemd-run' was not found in PATH. " +
            "Install systemd, remove the maxMemoryMb limit, or use a cloud sandbox backend.",
        );
      }

      return createInstance(opts.platform, validated.value, systemdRunAvailable);
    },
  };
}
