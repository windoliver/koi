/**
 * Vercel sandbox adapter configuration types.
 */

/** Vercel SDK sandbox creation options (internal). */
export interface VercelCreateOpts {
  readonly apiToken?: string;
  readonly teamId?: string;
  readonly projectId?: string;
}

/** Minimal interface wrapping the Vercel SDK sandbox instance. */
export interface VercelSdkSandbox {
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

/** Injectable Vercel client interface for testing. */
export interface VercelClient {
  readonly createSandbox: (opts: VercelCreateOpts) => Promise<VercelSdkSandbox>;
}

/** Vercel adapter configuration. */
export interface VercelAdapterConfig {
  /** API token. Falls back to VERCEL_TOKEN env var. */
  readonly apiToken?: string;
  /** Vercel team ID. */
  readonly teamId?: string;
  /** Vercel project ID. */
  readonly projectId?: string;
  /** Injectable client for testing. */
  readonly client?: VercelClient;
}
