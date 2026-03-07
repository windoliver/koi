import type { KoiError, Result, SandboxAdapter } from "@koi/core";
import type { E2bAdapterConfig } from "@koi/sandbox-e2b";

export async function createE2bAdapterShim(
  config: E2bAdapterConfig,
): Promise<Result<SandboxAdapter, KoiError>> {
  try {
    const mod = await import("@koi/sandbox-e2b");
    return mod.createE2bAdapter(config);
  } catch (error: unknown) {
    throw new Error("To use the E2B sandbox, install: bun add @koi/sandbox-e2b", {
      cause: error,
    });
  }
}
