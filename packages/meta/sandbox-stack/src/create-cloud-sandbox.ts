import type { KoiError, Result, SandboxAdapter } from "@koi/core";
import { createCloudflareAdapter } from "@koi/sandbox-cloudflare";
import { createDaytonaAdapter } from "@koi/sandbox-daytona";
import { createDockerAdapter } from "@koi/sandbox-docker";
import { createE2bAdapter } from "@koi/sandbox-e2b";
import { createVercelAdapter } from "@koi/sandbox-vercel";
import type { CloudSandboxConfig } from "./cloud-types.js";

/**
 * Dispatch factory — creates a SandboxAdapter for any supported cloud provider.
 *
 * Select provider via the `provider` discriminant field in config.
 * The remaining config fields are forwarded to the provider-specific factory.
 */
export function createCloudSandbox(config: CloudSandboxConfig): Result<SandboxAdapter, KoiError> {
  switch (config.provider) {
    case "cloudflare":
      return createCloudflareAdapter(config);
    case "daytona":
      return createDaytonaAdapter(config);
    case "docker":
      return createDockerAdapter(config);
    case "e2b":
      return createE2bAdapter(config);
    case "vercel":
      return createVercelAdapter(config);
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
