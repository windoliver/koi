import type { KoiError, Result } from "@koi/core";
import type { DockerAdapterConfig, ResolvedDockerConfig } from "./types.js";

const DEFAULT_IMAGE = "ubuntu:22.04";
const DEFAULT_SOCKET = "/var/run/docker.sock";

export function validateDockerImage(image: string): KoiError | undefined {
  if (image.trim().length === 0) {
    return {
      code: "VALIDATION",
      message: "Docker image must be a non-empty string",
      retryable: false,
    };
  }
  if (image.startsWith("-")) {
    return {
      code: "VALIDATION",
      message: "Docker image must not start with '-'",
      retryable: false,
      context: { image },
    };
  }
  return undefined;
}

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

  const image = (config.image ?? DEFAULT_IMAGE).trim();
  const imageError = validateDockerImage(image);
  if (imageError !== undefined) {
    return { ok: false, error: imageError };
  }

  return {
    ok: true,
    value: {
      socketPath: config.socketPath ?? DEFAULT_SOCKET,
      image,
      client: config.client,
    },
  };
}
