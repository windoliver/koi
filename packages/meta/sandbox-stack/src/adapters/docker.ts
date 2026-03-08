import type { KoiError, Result, SandboxAdapter } from "@koi/core";
import type { DockerAdapterConfig } from "../cloud-types.js";

export async function createDockerAdapterShim(
  config: DockerAdapterConfig,
): Promise<Result<SandboxAdapter, KoiError>> {
  try {
    const mod = await import("@koi/sandbox-docker");
    return mod.createDockerAdapter(config);
  } catch (error: unknown) {
    throw new Error("To use the Docker sandbox, install: bun add @koi/sandbox-docker", {
      cause: error,
    });
  }
}
