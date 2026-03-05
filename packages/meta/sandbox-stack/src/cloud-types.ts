import type { CloudflareAdapterConfig } from "@koi/sandbox-cloudflare";
import type { DaytonaAdapterConfig } from "@koi/sandbox-daytona";
import type { DockerAdapterConfig } from "@koi/sandbox-docker";
import type { E2bAdapterConfig } from "@koi/sandbox-e2b";
import type { VercelAdapterConfig } from "@koi/sandbox-vercel";

/** Discriminated union of all cloud sandbox provider configs. */
export type CloudSandboxConfig =
  | ({ readonly provider: "cloudflare" } & CloudflareAdapterConfig)
  | ({ readonly provider: "daytona" } & DaytonaAdapterConfig)
  | ({ readonly provider: "docker" } & DockerAdapterConfig)
  | ({ readonly provider: "e2b" } & E2bAdapterConfig)
  | ({ readonly provider: "vercel" } & VercelAdapterConfig);

/** String literal union of supported cloud sandbox providers. */
export type CloudSandboxProvider = CloudSandboxConfig["provider"];
