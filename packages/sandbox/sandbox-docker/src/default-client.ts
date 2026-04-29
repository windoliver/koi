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

function quoteShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Read from a ReadableStream<Uint8Array> up to maxBytes, then cancel the rest.
 * Returns the decoded text and a truncated flag.
 *
 * Prevents an adversarial container from OOMing the host by producing
 * unbounded output — we stop consuming (and cancel the stream) once the cap
 * is hit.
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
    const remaining = maxBytes - total;
    if (remaining <= 0) {
      truncated = true;
      reader.cancel().catch((_: unknown) => {
        // cancel errors are safe to ignore — we've already stopped reading
      });
      break;
    }
    const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
    buf += decoder.decode(chunk, { stream: true });
    total += chunk.byteLength;
    if (chunk.byteLength < value.byteLength) {
      truncated = true;
      reader.cancel().catch((_: unknown) => {
        // cancel errors are safe to ignore — we've already stopped reading
      });
      break;
    }
  }
  buf += decoder.decode();
  return { text: buf, truncated };
}

/**
 * Run a docker command with optional stdin and timeout.
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
): Promise<DockerExecResult> {
  const proc = Bun.spawn(["docker", ...args], {
    stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
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
 * Run a docker exec command with bounded output capture and optional cwd/timeout.
 * Applies readBoundedText to both stdout and stderr to prevent host OOM.
 */
async function runDockerExecBounded(
  args: readonly string[],
  execOpts: DockerExecOpts,
): Promise<DockerExecResult> {
  const maxBytes = execOpts.maxOutputBytes ?? DEFAULT_EXEC_MAX_OUTPUT_BYTES;
  const timeoutMs = execOpts.timeoutMs;

  const proc = Bun.spawn(["docker", ...args], {
    stdin:
      execOpts.stdin !== undefined ? new TextEncoder().encode(execOpts.stdin) : ("ignore" as const),
    stdout: "pipe",
    stderr: "pipe",
  });

  // `let` justified: timedOut and timer are mutated inside the callback.
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill(9);
    }, timeoutMs);
    if ("unref" in timer && typeof timer.unref === "function") timer.unref();
  }

  // Drain both streams with byte-cap to prevent host OOM from adversarial containers.
  const [stdoutResult, stderrResult, exitCode] = await Promise.all([
    readBoundedText(proc.stdout, maxBytes),
    readBoundedText(proc.stderr, maxBytes),
    proc.exited,
  ]);

  if (timer !== undefined) clearTimeout(timer);

  const truncated = stdoutResult.truncated || stderrResult.truncated;
  return {
    exitCode: timedOut ? 124 : (exitCode ?? -1),
    stdout: stdoutResult.text,
    stderr: stderrResult.text,
    truncated,
  };
}

/** Convenience wrapper for calls that do not need a timeout. */
async function runDocker(args: readonly string[], stdin?: string): Promise<DockerExecResult> {
  return runDockerWithTimeout(args, stdin, undefined);
}

function buildCreateArgs(opts: DockerCreateOpts): readonly string[] {
  // let is justified: we push CLI flags incrementally
  const args: string[] = ["create", "--network", opts.networkMode];
  if (opts.pidsLimit !== undefined) args.push("--pids-limit", String(opts.pidsLimit));
  if (opts.memoryMb !== undefined) args.push("--memory", `${opts.memoryMb}m`);
  for (const [k, v] of Object.entries(opts.env ?? {})) args.push("--env", `${k}=${v}`);
  for (const bind of opts.binds ?? []) args.push("--volume", bind);
  for (const cap of opts.capAdd ?? []) args.push("--cap-add", cap);
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

function makeContainer(id: string): DockerContainer {
  return {
    id,
    exec: async (cmd: string, execOpts: DockerExecOpts = {}): Promise<DockerExecResult> => {
      const args = buildExecArgs(id, cmd, execOpts);
      return runDockerExecBounded(args, execOpts);
    },
    readFile: async (path: string): Promise<Uint8Array> => {
      const r = await runDocker(["exec", id, "base64", path]);
      if (r.exitCode !== 0) {
        throw new Error(`readFile failed for container ${id}`, { cause: r });
      }
      const buf = Buffer.from(r.stdout.trim(), "base64");
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    writeFile: async (path: string, content: Uint8Array): Promise<void> => {
      const b64 = Buffer.from(content).toString("base64");
      const quotedPath = quoteShellArg(path);
      const r = await runDocker(["exec", "-i", id, "sh", "-c", `base64 -d > ${quotedPath}`], b64);
      if (r.exitCode !== 0) {
        throw new Error(`writeFile failed for container ${id}`, { cause: r });
      }
    },
    stop: async (): Promise<void> => {
      const r = await runDocker(["stop", id]);
      if (r.exitCode !== 0) {
        throw new Error(`docker stop failed for ${id}`, { cause: r });
      }
    },
    remove: async (): Promise<void> => {
      const r = await runDocker(["rm", "-f", id]);
      if (r.exitCode !== 0) {
        throw new Error(`docker rm -f failed for ${id}`, { cause: r });
      }
    },
  };
}

export function createDefaultDockerClient(): DockerClient {
  return {
    createContainer: async (opts: DockerCreateOpts): Promise<DockerContainer> => {
      const create = await runDocker(buildCreateArgs(opts));
      if (create.exitCode !== 0) {
        throw new Error("docker create failed", { cause: create });
      }
      const id = create.stdout.trim();
      const start = await runDocker(["start", id]);
      if (start.exitCode !== 0) {
        throw new Error("docker start failed", { cause: start });
      }
      return makeContainer(id);
    },
  };
}
