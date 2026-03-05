/**
 * E2B adapter configuration types.
 */

/** S3/GCS/R2 bucket FUSE mount configuration. */
export interface E2bBucketMount {
  readonly type: "s3" | "gcs" | "r2";
  readonly bucket: string;
  readonly mountPath: string;
  readonly credentials: Readonly<Record<string, string>>;
}

/** E2B SDK sandbox creation options (internal). */
export interface E2bCreateOpts {
  readonly template?: string;
  readonly apiKey?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Handle returned by E2B background process spawn. */
export interface E2bProcessHandle {
  readonly pid: number;
  readonly sendStdin: (data: string) => void | Promise<void>;
  readonly closeStdin: () => void;
  readonly exited: Promise<number>;
  readonly kill: (signal?: number) => void;
}

/** Minimal interface wrapping the E2B SDK sandbox instance. */
export interface E2bSdkSandbox {
  readonly commands: {
    readonly run: (
      cmd: string,
      opts?: {
        readonly cwd?: string;
        readonly envs?: Record<string, string>;
        readonly timeoutMs?: number;
        readonly onStdout?: (data: string) => void;
        readonly onStderr?: (data: string) => void;
      },
    ) => Promise<{
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }>;
    /**
     * Spawn a long-lived background process with streaming I/O.
     *
     * Maps to E2B SDK's `commands.run({ background: true })` which returns
     * a process handle with pid and stdin access.
     */
    readonly spawn?: (
      cmd: string,
      opts?: {
        readonly cwd?: string;
        readonly envs?: Record<string, string>;
        readonly onStdout?: (data: string) => void;
        readonly onStderr?: (data: string) => void;
      },
    ) => Promise<E2bProcessHandle>;
  };
  readonly files: {
    readonly read: (path: string) => Promise<string>;
    readonly write: (path: string, content: string) => Promise<void>;
  };
  readonly kill: () => Promise<void>;
}

/** Injectable E2B client interface for testing. */
export interface E2bClient {
  readonly createSandbox: (opts: E2bCreateOpts) => Promise<E2bSdkSandbox>;
}

/** E2B adapter configuration. */
export interface E2bAdapterConfig {
  /** API key. Falls back to E2B_API_KEY env var. */
  readonly apiKey?: string;
  /** Custom sandbox template ID. */
  readonly template?: string;
  /** FUSE bucket mounts (S3/GCS/R2). */
  readonly mounts?: readonly E2bBucketMount[];
  /** Injectable client for testing. */
  readonly client?: E2bClient;
}
