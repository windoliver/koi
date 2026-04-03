/**
 * Docker adapter config validation.
 */

import type { KoiError, Result } from "@koi/core";
import { createDefaultDockerClient } from "./default-client.js";
import type { DockerAdapterConfig, DockerClient } from "./types.js";

const DEFAULT_SOCKET_PATH = "/var/run/docker.sock";
const DEFAULT_IMAGE = "ubuntu:22.04";

/** Validated Docker config with resolved defaults and guaranteed client. */
export interface ValidatedDockerConfig {
  readonly socketPath: string;
  readonly image: string;
  readonly client: DockerClient;
}

/** Validate Docker adapter configuration, resolving defaults. */
export function validateDockerConfig(
  config: DockerAdapterConfig,
): Result<ValidatedDockerConfig, KoiError> {
  const socketPath = config.socketPath ?? DEFAULT_SOCKET_PATH;
  const image = config.image ?? DEFAULT_IMAGE;
  const client = config.client ?? createDefaultDockerClient(socketPath);

  if (socketPath === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Docker socket path must not be empty",
        retryable: false,
      },
    };
  }

  if (image === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Docker image must not be empty",
        retryable: false,
      },
    };
  }

  return { ok: true, value: { socketPath, image, client } };
}
