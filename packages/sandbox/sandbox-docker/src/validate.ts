import type { KoiError, Result } from "@koi/core";
import { createDefaultDockerClient } from "./default-client.js";
import type { DockerAdapterConfig, ResolvedDockerConfig } from "./types.js";

const DEFAULT_IMAGE = "ubuntu:22.04";
const DEFAULT_SOCKET = "/var/run/docker.sock";

/**
 * Validate and resolve Docker adapter config.
 *
 * When config.client is not provided, a default client backed by the local
 * Docker daemon is created automatically. UNAVAILABLE is only returned when
 * a reachability probe explicitly fails — currently we defer that check to
 * create-time (when `docker create` is invoked). If the daemon is not running,
 * createContainer() will throw a typed Error at that point.
 *
 * TODO: add a `detectDocker()` probe here to surface UNAVAILABLE eagerly at
 * adapter-creation time rather than at first `create()` call.
 */
export function validateDockerConfig(
  config: DockerAdapterConfig,
): Result<ResolvedDockerConfig, KoiError> {
  const client = config.client ?? createDefaultDockerClient();

  return {
    ok: true,
    value: {
      socketPath: config.socketPath ?? DEFAULT_SOCKET,
      image: config.image ?? DEFAULT_IMAGE,
      client,
    },
  };
}
