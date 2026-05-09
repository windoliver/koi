import type { DockerContainerState, DockerExecOpts, DockerExecResult } from "./types.js";

/** Default maximum output bytes for docker exec (1 MiB). */
export const DEFAULT_EXEC_MAX_OUTPUT_BYTES: number = 1 * 1024 * 1024;

/**
 * Host env vars forwarded to docker CLI subprocesses.
 *
 * PATH and HOME are required for docker to locate the binary and its config dir.
 * The DOCKER_* and XDG_CONFIG_HOME vars support non-default Docker contexts,
 * TLS authentication, custom config directories, and API version pinning.
 * DOCKER_HOST is included here so it is passed through when no socketPath is
 * configured; it is overridden below when socketPath is explicitly set.
 */
const DOCKER_PASSTHROUGH_KEYS: readonly string[] = [
  "PATH",
  "HOME",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_API_VERSION",
  "XDG_CONFIG_HOME",
];

/**
 * Build an env object for docker CLI subprocesses.
 * Forwards DOCKER_* and related vars from the host so non-default Docker contexts,
 * TLS, and custom config paths work correctly. When socketPath is provided,
 * DOCKER_HOST is set to "unix://<socketPath>" (overriding any host DOCKER_HOST)
 * so all docker commands target that daemon socket instead of the default.
 */
export function buildDockerEnv(socketPath: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of DOCKER_PASSTHROUGH_KEYS) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  if (socketPath !== undefined) env.DOCKER_HOST = `unix://${socketPath}`;
  return env;
}

export function quoteShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Read from a ReadableStream<Uint8Array> up to maxBytes, then drain silently.
 * Returns the decoded text and a truncated flag.
 *
 * Prevents an adversarial container from OOMing the host by capping accumulated
 * bytes, while continuing to drain the pipe so the docker CLI does not stall on
 * a full pipe buffer (which would produce a false TIMEOUT). The container is NOT
 * killed here — only timeout/abort triggers host-side proc.kill(9). In-container
 * processes are bounded by the `timeout` utility wrapper in buildExecArgs.
 */
export async function readBoundedText(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let truncated = false;
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    if (truncated) continue;
    const remaining = maxBytes - total;
    if (remaining <= 0) {
      truncated = true;
      continue;
    }
    if (value.byteLength > remaining) {
      buf += decoder.decode(value.subarray(0, remaining), { stream: true });
      total += remaining;
      truncated = true;
    } else {
      buf += decoder.decode(value, { stream: true });
      total += value.byteLength;
    }
  }
  buf += decoder.decode();
  return { text: buf, truncated };
}

/**
 * Run a docker command with optional stdin, timeout, and env override.
 * Drains stdout and stderr concurrently via Promise.all to prevent pipe-buffer deadlock.
 * When timeoutMs is set, kills the process after the deadline and returns exitCode 124
 * (the same sentinel that classify.ts maps to TIMEOUT).
 */
export async function runDockerWithTimeout(
  args: readonly string[],
  stdin?: string,
  timeoutMs?: number,
  env?: Record<string, string>,
): Promise<DockerExecResult> {
  const proc = Bun.spawn(["docker", ...args], {
    stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...(env !== undefined ? { env } : {}),
  });

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill(9);
    }, timeoutMs);
    if ("unref" in timer && typeof timer.unref === "function") timer.unref();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (timer !== undefined) clearTimeout(timer);

  return { exitCode: timedOut ? 124 : (exitCode ?? -1), stdout, stderr };
}

/** Convenience wrapper for calls that do not need a timeout. */
export async function runDocker(
  args: readonly string[],
  stdin?: string,
  env?: Record<string, string>,
): Promise<DockerExecResult> {
  return runDockerWithTimeout(args, stdin, undefined, env);
}

/**
 * Wrap a shell command with the container's `timeout` utility for deterministic
 * in-container termination. This prevents a per-exec timeout from killing the
 * container's PID 1 (sleep infinity) via `docker kill`, which would destroy the
 * entire sandbox and cause all subsequent exec/readFile/writeFile to silently fail.
 *
 * The container `timeout` binary kills only the wrapped command. The short-form
 * `-k 2` flag (SIGKILL 2 seconds after SIGTERM if still alive) is portable across
 * GNU coreutils (debian/ubuntu) and BusyBox (alpine).
 *
 * Exits with code 124 when the timeout fires — the same sentinel that classify.ts
 * maps to TIMEOUT.
 */
export function wrapCmdWithTimeout(cmd: string, timeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const inner = `timeout -k 2 ${seconds} sh -c ${quoteShellArg(cmd)}`;
  return `${inner}; rc=$?; if [ $rc -eq 143 ]; then exit 124; fi; exit $rc`;
}

/**
 * Run a docker exec command with bounded output capture and optional cwd/timeout/signal.
 * Applies readBoundedText to both stdout and stderr to prevent host OOM.
 * When signal is pre-aborted, returns immediately without spawning.
 */
export async function runDockerExecBounded(
  _containerId: string,
  args: readonly string[],
  execOpts: DockerExecOpts,
  env: Record<string, string>,
): Promise<DockerExecResult> {
  const maxBytes = execOpts.maxOutputBytes ?? DEFAULT_EXEC_MAX_OUTPUT_BYTES;
  const timeoutMs = execOpts.timeoutMs;
  const signal = execOpts.signal;

  if (signal?.aborted === true) {
    return { exitCode: 130, stdout: "", stderr: "", truncated: false };
  }

  const proc = Bun.spawn(["docker", ...args], {
    stdin:
      execOpts.stdin !== undefined ? new TextEncoder().encode(execOpts.stdin) : ("ignore" as const),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  let timedOut = false;
  let aborted = false;

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill(9);
    }, timeoutMs + 1000);
    if ("unref" in timer && typeof timer.unref === "function") timer.unref();
  }

  const onAbort = (): void => {
    aborted = true;
    proc.kill(9);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const stdoutP = readBoundedText(proc.stdout, maxBytes);
  const stderrP = readBoundedText(proc.stderr, maxBytes);

  const exitCode = await proc.exited;
  if (timer !== undefined) clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);

  const [stdoutResult, stderrResult] = await Promise.all([stdoutP, stderrP]);

  const truncated = stdoutResult.truncated || stderrResult.truncated;

  if (aborted && !timedOut) {
    return { exitCode: 130, stdout: "", stderr: "", truncated: false };
  }

  return {
    exitCode: timedOut ? 124 : (exitCode ?? -1),
    stdout: stdoutResult.text,
    stderr: stderrResult.text,
    truncated,
  };
}

/**
 * Map docker's `State.Status` field to the adapter-level `DockerContainerState`.
 * Docker reports: created, running, paused, restarting, removing, exited, dead.
 * We collapse paused/restarting/created → "stopped" so callers can simply
 * call `startContainer` and re-attach.
 */
export function mapInspectStatus(raw: string): DockerContainerState {
  const s = raw.trim().toLowerCase();
  if (s === "running") return "running";
  if (s === "exited") return "exited";
  if (s === "dead") return "dead";
  if (s === "created" || s === "paused" || s === "restarting") return "stopped";
  return "unknown";
}

/**
 * Parse the JSON label payload emitted by `docker inspect ... {{json .Config.Labels}}`.
 * Returns an empty record on any parse failure so a malformed daemon response
 * cannot crash the adapter; the calling code treats "no recorded fingerprint"
 * as a profile mismatch and fails closed.
 */
export function safeParseLabels(s: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(s);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}
