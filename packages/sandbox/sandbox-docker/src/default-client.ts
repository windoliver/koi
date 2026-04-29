import { Buffer } from "node:buffer";
import type {
  DockerClient,
  DockerContainer,
  DockerCreateOpts,
  DockerExecOpts,
  DockerExecResult,
} from "./types.js";

/** Default maximum output bytes for docker exec (1 MiB). */
const DEFAULT_EXEC_MAX_OUTPUT_BYTES = 1 * 1024 * 1024;

/**
 * Build a minimal env object for docker CLI subprocesses.
 * Only PATH and HOME are forwarded from the host (required for docker to
 * locate the binary and its config dir). When socketPath is provided,
 * DOCKER_HOST is set to "unix://<socketPath>" so all docker commands
 * target that daemon socket instead of the default.
 */
export function buildDockerEnv(socketPath: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME"] as const) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  if (socketPath !== undefined) env.DOCKER_HOST = `unix://${socketPath}`;
  return env;
}

function quoteShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Read from a ReadableStream<Uint8Array> up to maxBytes, then drain silently.
 * Returns the decoded text and a truncated flag.
 *
 * Prevents an adversarial container from OOMing the host by capping accumulated
 * bytes, while continuing to drain the pipe so the docker CLI does not stall on
 * a full pipe buffer (which would produce a false TIMEOUT). The container is NOT
 * killed here — only timeout/abort triggers kill (via docker kill in Fix 1).
 */
async function readBoundedText(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  // `let` justified: buf/total/truncated are accumulated across iterations
  let total = 0;
  let truncated = false;
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    if (truncated) continue; // already over cap — drain silently to keep pipe drained
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
 *
 * Note: non-exec operations (create/start/stop/rm) use this with no maxOutputBytes,
 * which is fine — their output is bounded by Docker itself (container IDs, status lines).
 */
async function runDockerWithTimeout(
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

  // `let` justified: timedOut and timer are mutated inside the callback.
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill(9);
    }, timeoutMs);
    // Prevent the timer from keeping the event loop alive unnecessarily.
    if ("unref" in timer && typeof timer.unref === "function") timer.unref();
  }

  // Drain stdout and stderr concurrently to prevent pipe-buffer deadlock.
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (timer !== undefined) clearTimeout(timer);

  // exitCode 124 is the sentinel for TIMEOUT (matches classify.ts mapping).
  return { exitCode: timedOut ? 124 : (exitCode ?? -1), stdout, stderr };
}

/**
 * Issue a best-effort `docker kill --signal=KILL <containerId>` to terminate
 * the in-container workload. The local docker CLI process is killed separately
 * by the caller. Errors are swallowed — the container may already be gone.
 * Clamped to a 2-second safety timeout so we never block the caller indefinitely.
 */
async function killContainerWorkload(
  containerId: string,
  env: Record<string, string>,
): Promise<void> {
  try {
    const killProc = Bun.spawn(["docker", "kill", "--signal=KILL", containerId], {
      env,
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore" as const,
    });
    // Race: either the kill resolves or we give up after 2 s.
    await Promise.race([
      killProc.exited,
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 2000);
        if ("unref" in t && typeof t.unref === "function") t.unref();
      }),
    ]);
  } catch (_: unknown) {
    // best-effort — swallow all errors
  }
}

/**
 * Run a docker exec command with bounded output capture and optional cwd/timeout/signal.
 * Applies readBoundedText to both stdout and stderr to prevent host OOM.
 * When signal is pre-aborted, returns immediately without spawning.
 * When signal fires mid-flight or timeout fires:
 *   - sends SIGKILL to the local docker CLI process (proc.kill(9))
 *   - ALSO spawns `docker kill --signal=KILL <containerId>` so the in-container
 *     workload is terminated (the docker CLI kill alone only kills the client process).
 * When output cap is hit, excess bytes are drained silently (drain-not-kill); the
 * container is allowed to complete naturally and truncated:true is returned.
 */
async function runDockerExecBounded(
  containerId: string,
  args: readonly string[],
  execOpts: DockerExecOpts,
  env: Record<string, string>,
): Promise<DockerExecResult> {
  const maxBytes = execOpts.maxOutputBytes ?? DEFAULT_EXEC_MAX_OUTPUT_BYTES;
  const timeoutMs = execOpts.timeoutMs;
  const signal = execOpts.signal;

  // Pre-aborted: don't even spawn.
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

  // `let` justified: timedOut/aborted are mutated inside callbacks.
  let timedOut = false;
  let aborted = false;

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill(9);
      // Also kill the in-container workload — the local docker CLI kill alone
      // only kills the client process; the container-side process keeps running.
      void killContainerWorkload(containerId, env);
    }, timeoutMs);
    if ("unref" in timer && typeof timer.unref === "function") timer.unref();
  }

  const onAbort = (): void => {
    aborted = true;
    proc.kill(9);
    // Same as timeout: also kill the in-container workload.
    void killContainerWorkload(containerId, env);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  // Drain both streams with byte-cap to prevent host OOM from adversarial containers.
  // Excess bytes beyond the cap are discarded silently (pipe stays drained so the
  // docker CLI does not stall). The container is NOT killed on cap — only on
  // timeout or abort (see above).
  const [stdoutResult, stderrResult, exitCode] = await Promise.all([
    readBoundedText(proc.stdout, maxBytes),
    readBoundedText(proc.stderr, maxBytes),
    proc.exited,
  ]);

  if (timer !== undefined) clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);

  const truncated = stdoutResult.truncated || stderrResult.truncated;

  // Aborted (and timer didn't fire first) → return 130.
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

/** Convenience wrapper for calls that do not need a timeout. */
async function runDocker(
  args: readonly string[],
  stdin?: string,
  env?: Record<string, string>,
): Promise<DockerExecResult> {
  return runDockerWithTimeout(args, stdin, undefined, env);
}

function buildCreateArgs(opts: DockerCreateOpts): readonly string[] {
  // let is justified: we push CLI flags incrementally
  const args: string[] = ["create", "--network", opts.networkMode];
  if (opts.pidsLimit !== undefined) args.push("--pids-limit", String(opts.pidsLimit));
  if (opts.memoryMb !== undefined) args.push("--memory", `${opts.memoryMb}m`);
  for (const [k, v] of Object.entries(opts.env ?? {})) args.push("--env", `${k}=${v}`);
  for (const bind of opts.binds ?? []) args.push("--volume", bind);
  for (const cap of opts.capAdd ?? []) args.push("--cap-add", cap);
  if (opts.readOnlyRoot === true) args.push("--read-only");
  for (const path of opts.tmpfsMounts ?? []) args.push("--tmpfs", path);
  args.push(opts.image, "sleep", "infinity");
  return args;
}

function buildExecArgs(id: string, cmd: string, execOpts: DockerExecOpts): readonly string[] {
  // `let` justified: args are built incrementally with optional flags
  const args: string[] = ["exec"];
  for (const [k, v] of Object.entries(execOpts.env ?? {})) args.push("--env", `${k}=${v}`);
  if (execOpts.cwd !== undefined) {
    // Pass cwd as a separate argv element after --workdir — no shell interpolation.
    args.push("--workdir", execOpts.cwd);
  }
  args.push(id, "sh", "-c", cmd);
  return args;
}

function makeContainer(id: string, env: Record<string, string>): DockerContainer {
  return {
    id,
    exec: async (cmd: string, execOpts: DockerExecOpts = {}): Promise<DockerExecResult> => {
      const args = buildExecArgs(id, cmd, execOpts);
      return runDockerExecBounded(id, args, execOpts, env);
    },
    readFile: async (path: string): Promise<Uint8Array> => {
      const r = await runDocker(["exec", id, "base64", path], undefined, env);
      if (r.exitCode !== 0) {
        throw new Error(`readFile failed for container ${id}`, { cause: r });
      }
      const buf = Buffer.from(r.stdout.trim(), "base64");
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    writeFile: async (path: string, content: Uint8Array): Promise<void> => {
      const b64 = Buffer.from(content).toString("base64");
      const quotedPath = quoteShellArg(path);
      const r = await runDocker(
        ["exec", "-i", id, "sh", "-c", `base64 -d > ${quotedPath}`],
        b64,
        env,
      );
      if (r.exitCode !== 0) {
        throw new Error(`writeFile failed for container ${id}`, { cause: r });
      }
    },
    stop: async (): Promise<void> => {
      const r = await runDocker(["stop", id], undefined, env);
      if (r.exitCode !== 0) {
        throw new Error(`docker stop failed for ${id}`, { cause: r });
      }
    },
    remove: async (): Promise<void> => {
      const r = await runDocker(["rm", "-f", id], undefined, env);
      if (r.exitCode !== 0) {
        throw new Error(`docker rm -f failed for ${id}`, { cause: r });
      }
    },
  };
}

export interface DefaultDockerClientConfig {
  readonly socketPath?: string;
}

export function createDefaultDockerClient(config?: DefaultDockerClientConfig): DockerClient {
  const env = buildDockerEnv(config?.socketPath);
  return {
    createContainer: async (opts: DockerCreateOpts): Promise<DockerContainer> => {
      const create = await runDocker(buildCreateArgs(opts), undefined, env);
      if (create.exitCode !== 0) {
        throw new Error("docker create failed", { cause: create });
      }
      const id = create.stdout.trim();
      try {
        const start = await runDocker(["start", id], undefined, env);
        if (start.exitCode !== 0) {
          throw new Error(`docker start failed for ${id}`, { cause: start });
        }
      } catch (e: unknown) {
        // Best-effort: remove the orphaned container. Don't mask the original error.
        try {
          await runDocker(["rm", "-f", id], undefined, env);
        } catch (_: unknown) {
          // ignore: original error wins
        }
        throw e;
      }
      return makeContainer(id, env);
    },
  };
}
