/**
 * Daytona sandbox adapter configuration types.
 */

/** Daytona native FUSE volume mount configuration. */
export interface DaytonaVolumeMount {
  readonly volumeId: string;
  /** Must start with /. */
  readonly mountPath: string;
}

/** Daytona SDK sandbox creation options (internal). */
export interface DaytonaCreateOpts {
  readonly apiKey?: string;
  readonly apiUrl?: string;
  readonly target?: string;
}

/** Minimal interface wrapping the Daytona SDK sandbox instance. */
export interface DaytonaSdkSandbox {
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
  };
  readonly files: {
    readonly read: (path: string) => Promise<string>;
    readonly write: (path: string, content: string) => Promise<void>;
  };
  readonly close: () => Promise<void>;
}

/** Injectable Daytona client interface for testing. */
export interface DaytonaClient {
  readonly createSandbox: (opts: DaytonaCreateOpts) => Promise<DaytonaSdkSandbox>;
}

/** Daytona adapter configuration. */
export interface DaytonaAdapterConfig {
  /** API key. Falls back to DAYTONA_API_KEY env var. */
  readonly apiKey?: string;
  /** API URL. Falls back to DAYTONA_API_URL env var. */
  readonly apiUrl?: string;
  /** Region target. Default: "us". */
  readonly target?: string;
  /** FUSE volume mounts. */
  readonly volumes?: readonly DaytonaVolumeMount[];
  /** Injectable client for testing. */
  readonly client?: DaytonaClient;
}
