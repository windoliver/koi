import type { KoiError, Result, SandboxAdapter } from "@koi/core";
import type { CloudflareAdapterConfig } from "@koi/sandbox-cloudflare";

export async function createCloudflareAdapterShim(
  config: CloudflareAdapterConfig,
): Promise<Result<SandboxAdapter, KoiError>> {
  try {
    const mod = await import("@koi/sandbox-cloudflare");
    return mod.createCloudflareAdapter(config);
  } catch (error: unknown) {
    throw new Error("To use the Cloudflare sandbox, install: bun add @koi/sandbox-cloudflare", {
      cause: error,
    });
  }
}
