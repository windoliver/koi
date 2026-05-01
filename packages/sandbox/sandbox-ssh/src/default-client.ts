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
import type { SshClient, SshClientFactory, SshExecResult, SshTarget } from "./types.js";

async function loadPrivateKey(keyPath: string): Promise<Buffer> {
  return fsReadFile(keyPath);
}

function execOnce(client: Client, command: string): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err !== undefined && err !== null) {
        reject(err);
        return;
      }
      let stdout = "";
      let stderr = "";
      let exitCode = 0;
      stream.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      stream.on("exit", (code: number | null) => {
        exitCode = code ?? -1;
      });
      stream.on("close", () => {
        resolve({ exitCode, stdout, stderr });
      });
      stream.on("error", reject);
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
  return new Promise((resolve) => {
    client.on("close", () => resolve());
    client.end();
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
    exec: (command: string) => execOnce(client, command),
    readFile: (path: string) => sftpReadFile(client, path),
    writeFile: (path: string, data: Uint8Array) => sftpWriteFile(client, path, data),
    end: () => endClient(client),
  };
}

export const defaultSshClientFactory: SshClientFactory = {
  connect,
};
