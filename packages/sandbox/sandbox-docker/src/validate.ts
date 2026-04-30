import type { KoiError, Result } from "@koi/core";
import type { DockerAdapterConfig, ResolvedDockerConfig } from "./types.js";

const DEFAULT_IMAGE = "ubuntu:22.04";
const DEFAULT_SOCKET = "/var/run/docker.sock";

/**
 * Validate and resolve Docker adapter config.
 *
 * Requires a client to be supplied by the caller. When no client is provided,
 * use createDockerAdapter() which probes for Docker availability first.
 */
export function validateDockerConfig(
  config: DockerAdapterConfig,
): Result<ResolvedDockerConfig, KoiError> {
  if (config.client === undefined) {
    return {
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "Docker client required — call createDockerAdapter() to probe availability",
        retryable: false,
      },
    };
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
