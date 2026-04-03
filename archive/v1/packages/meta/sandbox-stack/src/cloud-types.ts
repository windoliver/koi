/**
 * Cloud sandbox provider config types.
 *
 * Standalone structural types mirroring each backend package's config.
 * They allow @koi/sandbox-stack to be consumed without installing optional
 * backend packages.
 *
 * Install the provider package for injectable test clients
 * (e.g., `bun add @koi/sandbox-cloudflare`).
 */

// ── Mount / volume types ─────────────────────────────────────────────────

/** Cloudflare R2 FUSE mount configuration. */
export interface CloudflareR2Mount {
  readonly bucketName: string;
  readonly mountPath: string;
}

/** Daytona native FUSE volume mount configuration. */
export interface DaytonaVolumeMount {
  readonly volumeId: string;
  /** Must start with /. */
  readonly mountPath: string;
}

/** S3/GCS/R2 bucket FUSE mount configuration for E2B. */
export interface E2bBucketMount {
  readonly type: "s3" | "gcs" | "r2";
  readonly bucket: string;
  readonly mountPath: string;
  readonly credentials: Readonly<Record<string, string>>;
}

// ── Adapter config types ─────────────────────────────────────────────────

/** Cloudflare Workers sandbox config. Install @koi/sandbox-cloudflare for injectable client. */
export interface CloudflareAdapterConfig {
  readonly apiToken?: string;
  readonly accountId?: string;
  /** R2 FUSE mounts. */
  readonly r2Mounts?: readonly CloudflareR2Mount[];
}

/** Daytona sandbox config. Install @koi/sandbox-daytona for injectable client. */
export interface DaytonaAdapterConfig {
  readonly apiKey?: string;
  readonly apiUrl?: string;
  readonly target?: string;
  /** FUSE volume mounts. */
  readonly volumes?: readonly DaytonaVolumeMount[];
}

/** Docker sandbox config. Install @koi/sandbox-docker for injectable client. */
export interface DockerAdapterConfig {
  readonly socketPath?: string;
  readonly image?: string;
}

/** E2B sandbox config. Install @koi/sandbox-e2b for injectable client. */
export interface E2bAdapterConfig {
  readonly apiKey?: string;
  readonly template?: string;
  /** FUSE bucket mounts (S3/GCS/R2). */
  readonly mounts?: readonly E2bBucketMount[];
}

/** Vercel sandbox config. Install @koi/sandbox-vercel for injectable client. */
export interface VercelAdapterConfig {
  readonly apiToken?: string;
  readonly teamId?: string;
  readonly projectId?: string;
}

/** Discriminated union of all cloud sandbox provider configs. */
export type CloudSandboxConfig =
  | ({ readonly provider: "cloudflare" } & CloudflareAdapterConfig)
  | ({ readonly provider: "daytona" } & DaytonaAdapterConfig)
  | ({ readonly provider: "docker" } & DockerAdapterConfig)
  | ({ readonly provider: "e2b" } & E2bAdapterConfig)
  | ({ readonly provider: "vercel" } & VercelAdapterConfig);

/** String literal union of supported cloud sandbox providers. */
export type CloudSandboxProvider = CloudSandboxConfig["provider"];
