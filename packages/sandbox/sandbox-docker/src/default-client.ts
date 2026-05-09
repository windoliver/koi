import { Buffer } from "node:buffer";
import {
  DOCKER_NAME_CONFLICT_CODE,
  type DockerClient,
  type DockerContainer,
  type DockerContainerInfo,
  type DockerContainerState,
  type DockerCreateOpts,
  type DockerExecOpts,
  type DockerExecResult,
} from "./types.js";

/** Default maximum output bytes for docker exec (1 MiB). */
const DEFAULT_EXEC_MAX_OUTPUT_BYTES = 1 * 1024 * 1024;

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
 * killed here — only timeout/abort triggers host-side proc.kill(9). In-container
 * processes are bounded by the `timeout` utility wrapper in buildExecArgs.
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
 * Wrap a shell command with the container's `timeout` utility for deterministic
 * in-container termination. This prevents a per-exec timeout from killing the
 * container's PID 1 (sleep infinity) via `docker kill`, which would destroy the
 * entire sandbox and cause all subsequent exec/readFile/writeFile to silently fail.
 *
 * The container `timeout` binary kills only the wrapped command. The short-form
 * `-k 2` flag (SIGKILL 2 seconds after SIGTERM if still alive) is portable across
 * GNU coreutils (debian/ubuntu) and BusyBox (alpine). The long form `--kill-after`
 * is GNU-only and breaks on alpine images.
 *
 * Exits with code 124 when the timeout fires — the same sentinel that classify.ts
 * maps to TIMEOUT.
 */
function wrapCmdWithTimeout(cmd: string, timeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  // BusyBox `timeout` exits 143 (128+SIGTERM) when it fires, while GNU coreutils
  // exits 124. Remap 143 → 124 so callers see a single timeout sentinel regardless
  // of the in-container `timeout` implementation. Leave 137 (SIGKILL) alone so it
  // can still surface as OOM via classifyDockerExit.
  const inner = `timeout -k 2 ${seconds} sh -c ${quoteShellArg(cmd)}`;
  return `${inner}; rc=$?; if [ $rc -eq 143 ]; then exit 124; fi; exit $rc`;
}

/**
 * Run a docker exec command with bounded output capture and optional cwd/timeout/signal.
 * Applies readBoundedText to both stdout and stderr to prevent host OOM.
 * When signal is pre-aborted, returns immediately without spawning.
 *
 * Timeout strategy (in-container `timeout` wrapping):
 *   When timeoutMs is set, the command is wrapped with the container's `timeout`
 *   utility: `timeout -k 2 <s> sh -c <cmd>`. The container's `timeout`
 *   kills only the wrapped process — NOT PID 1 (sleep infinity). The host-side
 *   docker CLI process is also killed via proc.kill(9) to stop stream draining.
 *   This keeps the container alive after per-exec timeouts, so subsequent
 *   exec/readFile/writeFile calls still work.
 *
 * Abort strategy:
 *   proc.kill(9) terminates the docker CLI client (host side). The docker daemon
 *   notices the closed exec stream and tears down the exec instance. In-container
 *   workload may continue briefly until the daemon propagates the teardown.
 *   Use timeoutMs for hard guarantees; abort is best-effort cleanup only.
 *   `docker kill` is NOT called on abort — it would kill PID 1.
 *
 * When output cap is hit, excess bytes are drained silently (drain-not-kill); the
 * container is allowed to complete naturally and truncated:true is returned.
 */
async function runDockerExecBounded(
  _containerId: string,
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

  // The in-container timeout utility handles the hard deadline; we still arm a host-side
  // timer to kill the docker CLI client process (stops stream draining) shortly after the
  // in-container timeout fires. Add 1 s grace so the container's `timeout` exits first.
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
    // Kill the host-side docker CLI client to close the exec stream.
    // The in-container workload may continue briefly until the daemon notices
    // the closed exec stream. Use timeoutMs for hard in-container guarantees.
    proc.kill(9);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  // Start bounded drain readers BEFORE awaiting exit — they must run concurrently to
  // prevent pipe-buffer deadlock (adversarial container fills the pipe → docker CLI stalls
  // if readers are not running). Both streams are capped at maxBytes; excess bytes are
  // discarded silently so the docker CLI process does not stall on a full pipe buffer.
  const stdoutP = readBoundedText(proc.stdout, maxBytes);
  const stderrP = readBoundedText(proc.stderr, maxBytes);

  // Await child exit FIRST so the timer is cleared as soon as the child exits —
  // post-exit drain time does not count against the deadline. If timedOut was already
  // set by the timer callback before exit, the kill has already been issued.
  const exitCode = await proc.exited;
  if (timer !== undefined) clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);

  // Drain both pipes (already closed after child exit — just consumes buffered bytes).
  const [stdoutResult, stderrResult] = await Promise.all([stdoutP, stderrP]);

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
  for (const [k, v] of Object.entries(opts.labels ?? {})) args.push("--label", `${k}=${v}`);
  if (opts.name !== undefined) args.push("--name", opts.name);
  args.push(opts.image, "sleep", "infinity");
  return args;
}

/**
 * Map docker's `State.Status` field to the adapter-level `DockerContainerState`.
 * Docker reports: created, running, paused, restarting, removing, exited, dead.
 * We collapse paused/restarting/created → "stopped" so callers can simply
 * call `startContainer` and re-attach.
 */
function mapInspectStatus(raw: string): DockerContainerState {
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
function safeParseLabels(s: string): Record<string, string> {
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

function buildExecArgs(id: string, cmd: string, execOpts: DockerExecOpts): readonly string[] {
  // `let` justified: args are built incrementally with optional flags
  const args: string[] = ["exec"];
  for (const [k, v] of Object.entries(execOpts.env ?? {})) args.push("--env", `${k}=${v}`);
  if (execOpts.cwd !== undefined) {
    // Pass cwd as a separate argv element after --workdir — no shell interpolation.
    args.push("--workdir", execOpts.cwd);
  }
  // Wrap with in-container `timeout` when timeoutMs is set, so only the exec'd
  // process is killed — NOT PID 1 (sleep infinity) which would destroy the container.
  const wrappedCmd =
    execOpts.timeoutMs !== undefined && execOpts.timeoutMs > 0
      ? wrapCmdWithTimeout(cmd, execOpts.timeoutMs)
      : cmd;
  args.push(id, "sh", "-c", wrappedCmd);
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
    // Persistence: stop without remove so a later findOrCreate(scope) reattaches.
    detach: async (): Promise<void> => {
      const r = await runDocker(["stop", id], undefined, env);
      if (r.exitCode !== 0) {
        throw new Error(`docker stop failed for ${id}`, { cause: r });
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
        // Daemon-level uniqueness: when --name collides with an existing
        // container, surface a typed error so the persistence adapter can
        // recover by reattaching to the winner instead of treating this as
        // a fatal create failure.
        if (opts.name !== undefined && /is already in use by container/i.test(create.stderr)) {
          const conflict = Object.assign(
            new Error(`docker container name "${opts.name}" is already in use`),
            { code: DOCKER_NAME_CONFLICT_CODE } as const,
          );
          throw conflict;
        }
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
    findContainers: async (
      labels: Readonly<Record<string, string>>,
    ): Promise<readonly DockerContainer[]> => {
      // Build --filter label=K=V flags from the supplied label set. We query
      // `docker ps -a` (all states) once and return every match — the adapter
      // needs to detect ambiguous scopes (more than one container carrying the
      // same scope label) and clean them all up via destroyScope.
      const filterArgs: string[] = [];
      for (const [k, v] of Object.entries(labels)) {
        filterArgs.push("--filter", `label=${k}=${v}`);
      }
      const r = await runDocker(["ps", "-a", "-q", ...filterArgs], undefined, env);
      if (r.exitCode !== 0) {
        // Do NOT collapse a transient `docker ps` failure into "no matches".
        // findOrCreate would then proceed to fresh-create on the deterministic
        // --name (later colliding) or destroyScope would forget the registry
        // entry — both turn a momentary daemon outage into a wedged scope.
        throw new Error(
          `docker ps failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`}`,
          { cause: r },
        );
      }
      const ids = r.stdout
        .split("\n")
        .map((x) => x.trim())
        .filter((x) => x.length > 0);
      return ids.map((id) => makeContainer(id, env));
    },
    resolveImageId: async (imageRef: string): Promise<string | undefined> => {
      // `docker image inspect` resolves a tag/digest to its content-addressed ID
      // without contacting a registry. Returns undefined when the image is not
      // pulled locally — the adapter degrades to (image-string, profile) only.
      const r = await runDocker(
        ["image", "inspect", "--format", "{{.Id}}", imageRef],
        undefined,
        env,
      );
      if (r.exitCode !== 0) {
        // Differentiate "image not pulled locally" (legitimate degraded path
        // — fingerprint falls back to the tag string) from "daemon hiccup"
        // (must throw so drift detection is not silently disabled and the
        // adapter doesn't reattach to a container running the old rootfs).
        const blob = `${r.stderr}\n${r.stdout}`.toLowerCase();
        if (blob.includes("no such image") || blob.includes("no such object")) {
          return undefined;
        }
        throw new Error(
          `docker image inspect failed for ${imageRef}: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`}`,
          { cause: r },
        );
      }
      const id = r.stdout.trim();
      return id.length > 0 ? id : undefined;
    },
    inspectContainer: async (id: string): Promise<DockerContainerInfo | undefined> => {
      // Tab-separated output: "<status>\t<json-labels>". Using a literal tab
      // keeps both fields parseable even when label values contain commas/spaces.
      const r = await runDocker(
        ["inspect", "--format", "{{.State.Status}}\t{{json .Config.Labels}}", id],
        undefined,
        env,
      );
      if (r.exitCode !== 0) {
        // Distinguish "container truly gone" from "transient daemon hiccup".
        // The adapter forgets the registry entry on undefined, so collapsing
        // every failure into undefined would let a momentary docker outage
        // erase ownership for a container that still exists. Only the
        // "No such container/object" case (Docker's stable not-found phrase
        // for `docker inspect`) returns undefined; anything else throws so
        // the caller surfaces the real fault instead of dropping ownership.
        const blob = `${r.stderr}\n${r.stdout}`.toLowerCase();
        if (blob.includes("no such container") || blob.includes("no such object")) {
          return undefined;
        }
        throw new Error(`docker inspect failed for ${id}: ${r.stderr.trim() || r.stdout.trim()}`, {
          cause: r,
        });
      }
      const tab = r.stdout.indexOf("\t");
      if (tab === -1) {
        return { state: mapInspectStatus(r.stdout), labels: {} };
      }
      const statusRaw = r.stdout.slice(0, tab);
      const labelsRaw = r.stdout.slice(tab + 1).trim();
      // Docker emits the literal string "null" for an empty label set.
      const labels: Record<string, string> =
        labelsRaw === "" || labelsRaw === "null" ? {} : safeParseLabels(labelsRaw);
      return { state: mapInspectStatus(statusRaw), labels };
    },
    startContainer: async (id: string): Promise<void> => {
      const r = await runDocker(["start", id], undefined, env);
      if (r.exitCode !== 0) {
        throw new Error(`docker start failed for ${id}`, { cause: r });
      }
    },
  };
}
