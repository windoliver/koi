import type { KoiError, Result, SandboxAdapter, SandboxProfile } from "@koi/core";
import { createDockerInstance } from "./instance.js";
import { mapProfileToDockerOpts } from "./profile-to-opts.js";
import type { DockerAdapterConfig } from "./types.js";
import { validateDockerConfig } from "./validate.js";

export function createDockerAdapter(config: DockerAdapterConfig): Result<SandboxAdapter, KoiError> {
  const validated = validateDockerConfig(config);
  if (!validated.ok) return validated;
  const { client, image } = validated.value;

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
