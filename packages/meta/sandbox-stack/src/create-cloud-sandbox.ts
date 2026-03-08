import type { KoiError, Result, SandboxAdapter } from "@koi/core";
import { createCloudflareAdapterShim } from "./adapters/cloudflare.js";
import { createDaytonaAdapterShim } from "./adapters/daytona.js";
import { createDockerAdapterShim } from "./adapters/docker.js";
import { createE2bAdapterShim } from "./adapters/e2b.js";
import { createVercelAdapterShim } from "./adapters/vercel.js";
import type { CloudSandboxConfig } from "./cloud-types.js";

/**
 * Dispatch factory — creates a SandboxAdapter for any supported cloud provider.
 *
 * Select provider via the `provider` discriminant field in config.
 * The remaining config fields are forwarded to the provider-specific lazy-load shim.
 * Each provider package is dynamically imported only when its adapter is requested.
 */
export async function createCloudSandbox(
  config: CloudSandboxConfig,
): Promise<Result<SandboxAdapter, KoiError>> {
  switch (config.provider) {
    case "cloudflare":
      return createCloudflareAdapterShim(config);
    case "daytona":
      return createDaytonaAdapterShim(config);
    case "docker":
      return createDockerAdapterShim(config);
    case "e2b":
      return createE2bAdapterShim(config);
    case "vercel":
      return createVercelAdapterShim(config);
    default: {
      const _exhaustive: never = config;
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Unknown cloud sandbox provider: ${(config as { readonly provider: string }).provider}`,
          retryable: false,
          context: { provider: (config as { readonly provider: string }).provider },
        },
      };
    }
  }
}
