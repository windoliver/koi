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
  /** Key-value metadata for tagging sandboxes (used for scope-based lookup). */
  readonly metadata?: Readonly<Record<string, string>> | undefined;
}

/** Handle returned by Daytona background process spawn. */
export interface DaytonaProcessHandle {
  readonly pid: number;
  readonly sendStdin: (data: string) => void | Promise<void>;
  readonly closeStdin: () => void;
  readonly exited: Promise<number>;
  readonly kill: (signal?: number) => void;
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
    /**
     * Spawn a long-lived background process with streaming I/O.
     *
     * Maps to Daytona SDK's session-based execution with
     * `createSession()` + `sendSessionCommandInput()`.
     */
    readonly spawn?: (
      cmd: string,
      opts?: {
        readonly cwd?: string;
        readonly envs?: Record<string, string>;
        readonly onStdout?: (data: string) => void;
        readonly onStderr?: (data: string) => void;
      },
    ) => Promise<DaytonaProcessHandle>;
  };
  readonly files: {
    readonly read: (path: string) => Promise<string>;
    readonly write: (path: string, content: string) => Promise<void>;
  };
  readonly close: () => Promise<void>;
  /** Platform sandbox ID for lookup. */
  readonly id?: string | undefined;
}

/** Injectable Daytona client interface for testing. */
export interface DaytonaClient {
  readonly createSandbox: (opts: DaytonaCreateOpts) => Promise<DaytonaSdkSandbox>;
  /**
   * Find an existing sandbox by scope key.
   *
   * The client is responsible for scope resolution, typically by searching
   * platform metadata for `koi.sandbox.scope` matching the given scope key.
   *
   * Optional — enables cross-session persistence.
   */
  readonly findSandbox?: ((scope: string) => Promise<DaytonaSdkSandbox | undefined>) | undefined;
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
