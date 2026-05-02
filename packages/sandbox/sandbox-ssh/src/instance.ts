import type { SandboxAdapterResult, SandboxExecOptions, SandboxInstance } from "@koi/core";
import { composeCommandLine } from "./quote.js";
import type { SshClient } from "./types.js";

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576; // 1 MB — matches sandbox-os default

/**
 * Build a SandboxInstance backed by a connected SSH client.
 *
 * `exec` quotes the command + args via `composeCommandLine` (POSIX shell
 * escaping) and runs over the existing SSH connection. `readFile`/`writeFile`
 * proxy to the client's SFTP wrappers.
 *
 * `destroy` closes the SSH connection. Subsequent calls on this instance
 * become rejected promises (the underlying ssh2 connection refuses ops once
 * `end()` has been called).
 */
async function execOverClient(
  client: SshClient,
  command: string,
  args: readonly string[],
  opts: SandboxExecOptions | undefined,
): Promise<SandboxAdapterResult> {
  const start = Date.now();
  const line = composeCommandLine(command, args);
  const result = await client.exec(line, {
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts?.onStdout !== undefined ? { onStdout: opts.onStdout } : {}),
    ...(opts?.onStderr !== undefined ? { onStderr: opts.onStderr } : {}),
  });
  const max = opts?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const stdout = truncate(result.stdout, max);
  const stderr = truncate(result.stderr, max);
  const truncated = stdout.length < result.stdout.length || stderr.length < result.stderr.length;
  return {
    exitCode: result.exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - start,
    timedOut: result.timedOut ?? false,
    oomKilled: false,
    truncated,
  };
}

export function createSshInstance(client: SshClient): SandboxInstance {
  let destroyed = false;
  const guard = (): void => {
    if (destroyed) throw new Error("sandbox-ssh: instance has been destroyed");
  };

  return {
    async exec(command, args, opts) {
      guard();
      return execOverClient(client, command, args, opts);
    },
    async readFile(path) {
      guard();
      return client.readFile(path);
    },
    async writeFile(path, data) {
      guard();
      return client.writeFile(path, data);
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      await client.end();
    },
    async detach() {
      if (destroyed) return;
      destroyed = true;
    },
  };
}

function truncate(s: string, maxBytes: number): string {
  // Cheap approximation — cap at codepoint count when string is short.
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  // Step back until under the byte limit.
  let truncated = s;
  while (Buffer.byteLength(truncated, "utf8") > maxBytes) {
    truncated = truncated.slice(0, -1);
  }
  return truncated;
}
