/**
 * Docker SandboxAdapter factory.
 */

import type { KoiError, Result, SandboxAdapter, SandboxProfile } from "@koi/core";
import { createDockerInstance } from "./instance.js";
import { resolveNetworkConfig } from "./network.js";
import { profileToDockerOpts } from "./profile-to-opts.js";
import type { DockerAdapterConfig } from "./types.js";
import { validateDockerConfig } from "./validate.js";

/** Label key used to tag containers with their persistence scope. */
const SCOPE_LABEL = "koi.sandbox.scope";

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
  const client = resolvedConfig.client;

  const findContainerFn = client.findContainer;
  const inspectStateFn = client.inspectState;
  const startContainerFn = client.startContainer;
  const canFindOrCreate =
    findContainerFn !== undefined && inspectStateFn !== undefined && startContainerFn !== undefined;

  return {
    ok: true,
    value: {
      name: "docker",
      create: async (profile: SandboxProfile) => {
        const { opts, networkConfig } = profileToDockerOpts(profile, resolvedConfig.image);
        const container = await client.createContainer(opts);
        return createDockerInstance(container, networkConfig);
      },
      ...(canFindOrCreate
        ? {
            findOrCreate: async (scope: string, profile: SandboxProfile) => {
              const labels = { [SCOPE_LABEL]: scope };
              const existing = await findContainerFn(labels);

              if (existing !== undefined) {
                const state = await inspectStateFn(existing.id);

                if (state === "running") {
                  const networkConfig = resolveNetworkConfig(profile.network ?? { allow: false });
                  return createDockerInstance(existing, networkConfig, { detachable: true });
                }

                if (state === "exited" || state === "stopped") {
                  await startContainerFn(existing.id);
                  const networkConfig = resolveNetworkConfig(profile.network ?? { allow: false });
                  return createDockerInstance(existing, networkConfig, { detachable: true });
                }

                // Dead or unknown — fall through to create fresh
              }

              // Create new container with scope label
              const { opts, networkConfig } = profileToDockerOpts(profile, resolvedConfig.image);
              const optsWithLabels = {
                ...opts,
                labels: { ...opts.labels, ...labels },
              };
              const container = await client.createContainer(optsWithLabels);
              return createDockerInstance(container, networkConfig, { detachable: true });
            },
          }
        : {}),
    },
  };
}
