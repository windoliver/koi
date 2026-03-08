/**
 * Cloud sandbox provider config types.
 *
 * These are standalone structural types containing only the common credential
 * fields of each backend package's config. They allow @koi/sandbox-stack to be
 * consumed without installing optional backend packages.
 *
 * Install the provider package for full vendor-specific types including mount
 * configs, injectable test clients, etc. (e.g., `bun add @koi/sandbox-cloudflare`).
 */

/** Cloudflare Workers sandbox config. Install @koi/sandbox-cloudflare for full types. */
export interface CloudflareAdapterConfig {
  readonly apiToken?: string;
  readonly accountId?: string;
}

/** Daytona sandbox config. Install @koi/sandbox-daytona for full types. */
export interface DaytonaAdapterConfig {
  readonly apiKey?: string;
  readonly apiUrl?: string;
  readonly target?: string;
}

/** Docker sandbox config. Install @koi/sandbox-docker for full types. */
export interface DockerAdapterConfig {
  readonly socketPath?: string;
  readonly image?: string;
}

/** E2B sandbox config. Install @koi/sandbox-e2b for full types. */
export interface E2bAdapterConfig {
  readonly apiKey?: string;
  readonly template?: string;
}

/** Vercel sandbox config. Install @koi/sandbox-vercel for full types. */
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
