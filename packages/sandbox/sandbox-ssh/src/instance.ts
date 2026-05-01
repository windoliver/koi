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
export function createSshInstance(client: SshClient): SandboxInstance {
  let destroyed = false;

  return {
    async exec(
      command: string,
      args: readonly string[],
      opts?: SandboxExecOptions,
    ): Promise<SandboxAdapterResult> {
      if (destroyed) {
        throw new Error("sandbox-ssh: instance has been destroyed");
      }
      const start = Date.now();
      const line = composeCommandLine(command, args);
      const result = await client.exec(line);
      const max = opts?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const stdout = truncate(result.stdout, max);
      const stderr = truncate(result.stderr, max);
      const truncated =
        stdout.length < result.stdout.length || stderr.length < result.stderr.length;
      return {
        exitCode: result.exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        timedOut: false,
        oomKilled: false,
        truncated,
      };
    },
    async readFile(path: string): Promise<Uint8Array> {
      if (destroyed) throw new Error("sandbox-ssh: instance has been destroyed");
      return client.readFile(path);
    },
    async writeFile(path: string, data: Uint8Array): Promise<void> {
      if (destroyed) throw new Error("sandbox-ssh: instance has been destroyed");
      return client.writeFile(path, data);
    },
    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      await client.end();
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
