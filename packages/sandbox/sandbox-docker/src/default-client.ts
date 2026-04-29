import { Buffer } from "node:buffer";
import type {
  DockerClient,
  DockerContainer,
  DockerCreateOpts,
  DockerExecOpts,
  DockerExecResult,
} from "./types.js";

function quoteShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Run a docker command with optional stdin and timeout.
 * Drains stdout and stderr concurrently via Promise.all to prevent pipe-buffer deadlock.
 * When timeoutMs is set, kills the process after the deadline and returns exitCode 124
 * (the same sentinel that classify.ts maps to TIMEOUT).
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

function makeContainer(id: string): DockerContainer {
  return {
    id,
    exec: async (cmd: string, execOpts: DockerExecOpts = {}): Promise<DockerExecResult> => {
      const args: string[] = ["exec"];
      for (const [k, v] of Object.entries(execOpts.env ?? {})) args.push("--env", `${k}=${v}`);
      args.push(id, "sh", "-c", cmd);
      return runDockerWithTimeout(args, execOpts.stdin, execOpts.timeoutMs);
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
      await runDocker(["stop", id]);
    },
    remove: async (): Promise<void> => {
      await runDocker(["rm", "-f", id]);
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
