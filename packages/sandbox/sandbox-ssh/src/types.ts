/**
 * Internal SSH client abstraction. The real implementation in `default-client.ts`
 * delegates to the `ssh2` package; tests inject a `SshClient` stub to avoid
 * needing a live SSH server.
 *
 * This interface intentionally exposes only the operations the adapter needs —
 * not the full ssh2 API. Adding a method here means adding an entry to the
 * DI seam.
 */

export interface SshExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SshClient {
  /** Run a fully-quoted POSIX shell command line; buffer stdout+stderr. */
  readonly exec: (command: string) => Promise<SshExecResult>;
  /** Read a remote file via SFTP. */
  readonly readFile: (path: string) => Promise<Uint8Array>;
  /** Write a remote file via SFTP. */
  readonly writeFile: (path: string, data: Uint8Array) => Promise<void>;
  /** Close the underlying SSH connection. */
  readonly end: () => Promise<void>;
}

/**
 * Caller-supplied factory that produces a connected `SshClient` from a target.
 * The default factory wraps `ssh2.Client.connect`. Tests inject a fake.
 */
export interface SshClientFactory {
  readonly connect: (target: SshTarget) => Promise<SshClient>;
}

export interface SshTarget {
  readonly host: string;
  readonly user: string;
  readonly keyPath: string;
  /** TCP port. Defaults to 22 when omitted. */
  readonly port?: number;
}

export interface SshAdapterConfig {
  /** Caller-supplied SSH connection factory. Required — no implicit default. */
  readonly clientFactory: SshClientFactory;
}
