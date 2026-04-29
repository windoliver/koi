import type { KoiError, Result, SandboxAdapter, SandboxProfile } from "@koi/core";
import { createDefaultDockerClient } from "./default-client.js";
import { detectDocker } from "./detect.js";
import { createDockerInstance } from "./instance.js";
import { mapProfileToDockerOpts } from "./profile-to-opts.js";
import type { DockerAdapterConfig } from "./types.js";
import { validateDockerConfig } from "./validate.js";

/**
 * Create a Docker sandbox adapter.
 *
 * When config.client is provided, validation is synchronous — no probe required.
 * When config.client is absent, probes Docker availability via detectDocker().
 * Returns ok: false with code "UNAVAILABLE" if Docker is not reachable.
 *
 * The optional `probe` field on config is for testing — defaults to detectDocker.
 */
export async function createDockerAdapter(
  config: DockerAdapterConfig,
): Promise<Result<SandboxAdapter, KoiError>> {
  // Fast path: client already provided — skip probe.
  if (config.client !== undefined) {
    const validated = validateDockerConfig(config);
    if (!validated.ok) return validated;
    const { client, image } = validated.value;
    return buildAdapter(client, image);
  }

  // Slow path: probe Docker availability before constructing default client.
  const probe = config.probe;
  const socketPath = config.socketPath;
  // Build detectOpts without optional keys set to `undefined` (exactOptionalPropertyTypes).
  const detectOpts =
    probe !== undefined && socketPath !== undefined
      ? { probe, socketPath }
      : probe !== undefined
        ? { probe }
        : socketPath !== undefined
          ? { socketPath }
          : {};
  const availability = await detectDocker(detectOpts);
  if (!availability.available) {
    return {
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: availability.reason ?? "Docker daemon is not available",
        retryable: false,
      },
    };
  }

  const client = createDefaultDockerClient(socketPath !== undefined ? { socketPath } : undefined);
  const image = config.image ?? "ubuntu:22.04";
  return buildAdapter(client, image);
}

function buildAdapter(
  client: import("./types.js").DockerClient,
  image: string,
): Result<SandboxAdapter, KoiError> {
  return {
    ok: true,
    value: {
      name: "docker",
      create: async (profile: SandboxProfile) => {
        const { opts } = mapProfileToDockerOpts(profile, image);
        const container = await client.createContainer(opts);
        return createDockerInstance(container);
      },
    },
  };
}
