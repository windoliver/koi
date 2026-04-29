/**
 * Internal Docker adapter types. Public adapter is exported via index.ts.
 */

export interface DockerExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when stdout or stderr was truncated due to maxOutputBytes. */
  readonly truncated?: boolean;
}

export interface DockerExecOpts {
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  /** Working directory inside the container. */
  readonly cwd?: string;
  /** Maximum bytes to buffer for stdout + stderr combined. */
  readonly maxOutputBytes?: number;
}

export interface DockerContainer {
  readonly id: string;
  readonly exec: (cmd: string, opts?: DockerExecOpts) => Promise<DockerExecResult>;
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly writeFile: (path: string, content: Uint8Array) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly remove: () => Promise<void>;
}

export interface DockerCreateOpts {
  readonly image: string;
  readonly networkMode: "none" | "bridge";
  readonly env?: Readonly<Record<string, string>>;
  readonly memoryMb?: number;
  readonly pidsLimit?: number;
  readonly binds?: readonly string[];
  readonly capAdd?: readonly string[];
}

export interface DockerClient {
  readonly createContainer: (opts: DockerCreateOpts) => Promise<DockerContainer>;
}

export interface DockerAdapterConfig {
  readonly socketPath?: string;
  readonly image?: string;
  readonly client?: DockerClient;
  /**
   * Optional probe function injected for testing.
   * Defaults to running `docker version` via detectDocker().
   * Only used when client is not provided (the availability-probe code path).
   */
  readonly probe?: () => Promise<number>;
}

export interface ResolvedDockerConfig {
  readonly socketPath: string;
  readonly image: string;
  readonly client: DockerClient;
}
