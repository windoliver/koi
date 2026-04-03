import type { KoiError, Result, SandboxAdapter } from "@koi/core";
import type { VercelAdapterConfig } from "../cloud-types.js";

export async function createVercelAdapterShim(
  config: VercelAdapterConfig,
): Promise<Result<SandboxAdapter, KoiError>> {
  try {
    const mod = await import("@koi/sandbox-vercel");
    return mod.createVercelAdapter(config);
  } catch (error: unknown) {
    throw new Error("To use the Vercel sandbox, install: bun add @koi/sandbox-vercel", {
      cause: error,
    });
  }
}
