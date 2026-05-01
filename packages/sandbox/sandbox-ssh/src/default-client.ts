/**
 * Default `SshClient` backed by the `ssh2` npm package. The factory:
 *
 *   1. Reads the private key from `target.keyPath` (callers must pre-grant FS access).
 *   2. Calls `ssh2.Client.connect` with strict host-key handling left to the caller's
 *      `~/.ssh/known_hosts` (`hostHash`/`hostVerifier` not configured here).
 *   3. Resolves with a wrapper exposing exec / readFile / writeFile / end.
 *
 * Each `exec` call opens a fresh channel; the connection itself is reused for the
 * lifetime of the wrapper (one connection per `SandboxInstance`).
 */

import { readFile as fsReadFile } from "node:fs/promises";
import { Client } from "ssh2";
import type {
  SshClient,
  SshClientFactory,
  SshExecOptions,
  SshExecResult,
  SshTarget,
} from "./types.js";

async function loadPrivateKey(keyPath: string): Promise<Buffer> {
  return fsReadFile(keyPath);
}

function execOnce(
  client: Client,
  command: string,
  options?: SshExecOptions,
): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err !== undefined && err !== null) {
        reject(err);
        return;
      }
      let stdout = "";
      let stderr = "";
      // exitCode = undefined until the remote signals "exit". If "close" fires
      // without an exit (e.g., the connection dropped mid-command), reject —
      // resolving with 0 would silently mask a transport failure.
      let exitCode: number | undefined;
      let exitSignal: string | undefined;
      let timedOut = false;
      let aborted = false;
      // let — assigned once; cleared on settle to allow GC.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (options?.signal !== undefined) {
          options.signal.removeEventListener("abort", onAbort);
        }
      };
      const killChannel = (): void => {
        try {
          stream.signal("KILL");
        } catch {
          // Best-effort: some servers don't honour signal requests. Fall back
          // to closing the stream directly.
        }
        try {
          stream.close();
        } catch {
          // Already closed.
        }
      };
      const onAbort = (): void => {
        aborted = true;
        killChannel();
      };

      if (options?.timeoutMs !== undefined && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          killChannel();
        }, options.timeoutMs);
      }
      if (options?.signal !== undefined) {
        if (options.signal.aborted) {
          aborted = true;
          killChannel();
        } else {
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      stream.on("data", (chunk: Buffer) => {
        const s = chunk.toString("utf8");
        stdout += s;
        // Streaming-callback exceptions must not bypass cleanup nor leak past
        // the promise — observers are advisory.
        try {
          options?.onStdout?.(s);
        } catch {
          // Swallow — observer failures cannot retroactively unmake the data.
        }
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        const s = chunk.toString("utf8");
        stderr += s;
        try {
          options?.onStderr?.(s);
        } catch {
          // Swallow.
        }
      });
      stream.on("exit", (code: number | null, signal?: string) => {
        exitCode = code ?? -1;
        if (signal !== undefined) exitSignal = signal;
        // Cancel the timeout the moment the remote signals exit; otherwise
        // the timer may fire AFTER a clean exit if "close" is delayed,
        // producing the contradiction { exitCode: 0, timedOut: true }.
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      });
      stream.on("close", () => {
        cleanup();
        if (timedOut || aborted) {
          // Surface timeout/abort as a non-zero result with telemetry rather
          // than rejecting — callers (e.g., bash-tool) need the partial
          // stdout/stderr captured up to the kill point.
          resolve({
            exitCode: exitCode ?? 124, // POSIX timeout convention
            stdout,
            stderr,
            timedOut,
            aborted,
          });
          return;
        }
        if (exitCode === undefined) {
          reject(
            new Error(
              `sandbox-ssh: ssh stream closed without exit signal${
                exitSignal !== undefined ? ` (signal=${exitSignal})` : ""
              } — connection likely dropped`,
            ),
          );
          return;
        }
        resolve({ exitCode, stdout, stderr });
      });
      stream.on("error", (e: Error) => {
        cleanup();
        reject(e);
      });
    });
  });
}

async function sftpReadFile(client: Client, path: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err !== undefined && err !== null) {
        reject(err);
        return;
      }
      sftp.readFile(path, (rerr, data) => {
        sftp.end();
        if (rerr !== undefined && rerr !== null) {
          reject(rerr);
          return;
        }
        resolve(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      });
    });
  });
}

async function sftpWriteFile(client: Client, path: string, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err !== undefined && err !== null) {
        reject(err);
        return;
      }
      sftp.writeFile(path, Buffer.from(data), (werr) => {
        sftp.end();
        if (werr !== undefined && werr !== null) {
          reject(werr);
          return;
        }
        resolve();
      });
    });
  });
}

function endClient(client: Client): Promise<void> {
  // ssh2.Client emits "close" exactly once. If the client already closed
  // (e.g., a sibling instance ended the same shared connection), our newly
  // attached listener will never fire. Guard with a short timeout so destroy
  // is always observable as resolved.
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), 200);
    client.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      client.end();
    } catch {
      // Already-ended clients throw on end() — close listener won't fire,
      // but the timer above will resolve us safely.
    }
  });
}

async function connect(target: SshTarget): Promise<SshClient> {
  const privateKey = await loadPrivateKey(target.keyPath);
  const client = new Client();
  await new Promise<void>((resolve, reject) => {
    client.on("ready", () => resolve());
    client.on("error", reject);
    const connectOpts =
      target.port !== undefined
        ? { host: target.host, username: target.user, port: target.port, privateKey }
        : { host: target.host, username: target.user, privateKey };
    client.connect(connectOpts);
  });

  return {
    exec: (command: string, options?: SshExecOptions) => execOnce(client, command, options),
    readFile: (path: string) => sftpReadFile(client, path),
    writeFile: (path: string, data: Uint8Array) => sftpWriteFile(client, path, data),
    end: () => endClient(client),
  };
}

export const defaultSshClientFactory: SshClientFactory = {
  connect,
};
