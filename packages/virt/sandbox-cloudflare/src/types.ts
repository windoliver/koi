/**
 * Cloudflare sandbox adapter configuration types.
 */

/** Cloudflare R2 FUSE mount configuration. */
export interface CloudflareR2Mount {
  readonly bucketName: string;
  readonly mountPath: string;
}

/** Cloudflare SDK sandbox creation options (internal). */
export interface CfCreateOpts {
  readonly apiToken?: string;
  readonly accountId?: string;
}

/** Minimal interface wrapping the Cloudflare SDK sandbox instance. */
export interface CfSdkSandbox {
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

/** Injectable Cloudflare client interface for testing. */
export interface CloudflareClient {
  readonly createSandbox: (opts: CfCreateOpts) => Promise<CfSdkSandbox>;
}

/** Cloudflare adapter configuration. */
export interface CloudflareAdapterConfig {
  /** API token. Falls back to CLOUDFLARE_API_TOKEN env var. */
  readonly apiToken?: string;
  /** Cloudflare account ID. */
  readonly accountId?: string;
  /** R2 FUSE mounts. */
  readonly r2Mounts?: readonly CloudflareR2Mount[];
  /** Injectable client for testing. */
  readonly client?: CloudflareClient;
}
