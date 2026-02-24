/**
 * Docker SandboxAdapter factory.
 */

import type { KoiError, Result, SandboxAdapter, SandboxProfile } from "@koi/core";
import { createDockerInstance } from "./instance.js";
import { profileToDockerOpts } from "./profile-to-opts.js";
import type { DockerAdapterConfig } from "./types.js";
import { validateDockerConfig } from "./validate.js";

/**
 * Create a Docker SandboxAdapter.
 *
 * Validates configuration and returns a Result. On success, the adapter
 * creates Docker container sandbox instances on demand.
 *
 * Unlike cloud adapters, Docker reads the SandboxProfile to enforce
 * filesystem, resource, and network policies at the container level.
 */
export function createDockerAdapter(config: DockerAdapterConfig): Result<SandboxAdapter, KoiError> {
  const validated = validateDockerConfig(config);
  if (!validated.ok) return validated;

  const resolvedConfig = validated.value;
  const client = config.client;

  return {
    ok: true,
    value: {
      name: "docker",
      create: async (profile: SandboxProfile) => {
        if (client !== undefined) {
          const { opts, networkConfig } = profileToDockerOpts(profile, resolvedConfig.image);
          const container = await client.createContainer(opts);
          return createDockerInstance(container, networkConfig);
        }

        throw new Error(
          "Docker client not provided. " +
            "Pass a client in DockerAdapterConfig for production use, " +
            "or use a mock client for testing.",
        );
      },
    },
  };
}
