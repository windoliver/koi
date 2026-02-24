/**
 * Docker adapter configuration types.
 */

/** Result of executing a command inside a Docker container. */
export interface DockerExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Options for executing a command inside a Docker container. */
export interface DockerExecOpts {
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
}

/** Minimal interface wrapping a Docker container instance. */
export interface DockerContainer {
  readonly id: string;
  readonly exec: (cmd: string, opts?: DockerExecOpts) => Promise<DockerExecResult>;
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, content: string) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly remove: () => Promise<void>;
}

/** Docker container creation options (internal). */
export interface DockerCreateOpts {
  readonly image: string;
  readonly networkMode: "none" | "bridge" | string;
  readonly env?: Readonly<Record<string, string>>;
  readonly memory?: number;
  readonly pidsLimit?: number;
  readonly binds?: readonly string[];
  readonly capAdd?: readonly string[];
}

/** Injectable Docker client interface for testing. */
export interface DockerClient {
  readonly createContainer: (opts: DockerCreateOpts) => Promise<DockerContainer>;
}

/** Docker adapter configuration. */
export interface DockerAdapterConfig {
  /** Path to Docker socket. Defaults to /var/run/docker.sock. */
  readonly socketPath?: string;
  /** Docker image to use. Defaults to "ubuntu:22.04". */
  readonly image?: string;
  /** Injectable client for testing. */
  readonly client?: DockerClient;
}
