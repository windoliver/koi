import type { KoiError, Result } from "@koi/core";
import type { DockerAdapterConfig, ResolvedDockerConfig } from "./types.js";

const DEFAULT_IMAGE = "ubuntu:22.04";
const DEFAULT_SOCKET = "/var/run/docker.sock";

export function validateDockerConfig(
  config: DockerAdapterConfig,
): Result<ResolvedDockerConfig, KoiError> {
  if (config.client === undefined) {
    const error: KoiError = {
      code: "UNAVAILABLE",
      message:
        "Docker client is required; provide a DockerClient via config.client or ensure the Docker daemon is reachable",
      retryable: false,
    };
    return { ok: false, error };
  }

  return {
    ok: true,
    value: {
      socketPath: config.socketPath ?? DEFAULT_SOCKET,
      image: config.image ?? DEFAULT_IMAGE,
      client: config.client,
    },
  };
}
