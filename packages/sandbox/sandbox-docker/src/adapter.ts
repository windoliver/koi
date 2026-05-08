import type {
  AdapterCapabilities,
  AdapterCapability,
  KoiError,
  Result,
  SandboxAdapter,
  SandboxInstance,
  SandboxProfile,
} from "@koi/core";
import { createDefaultDockerClient } from "./default-client.js";
import { detectDocker } from "./detect.js";
import { createDockerInstance } from "./instance.js";
import { mapProfileToDockerOpts } from "./profile-to-opts.js";
import type { DockerAdapterConfig, DockerClient, DockerCreateOpts } from "./types.js";
import { validateDockerConfig } from "./validate.js";

/** Label key used to tag containers with their persistence scope. */
const SCOPE_LABEL = "koi.sandbox.scope";

/**
 * Adapter capabilities depend on whether the underlying DockerClient supports
 * the persistence triple (findContainer + inspectState + startContainer).
 *
 * Honesty: we declare `persistence` only when the client can actually find,
 * inspect, and resume a previously created container. The default Docker CLI
 * client supports all three; injected test clients may opt out.
 */
const BASE_SUPPORTED: readonly AdapterCapability[] = [
  "exec",
  "copy-files",
  "network",
  "filesystem-rw",
];

function buildCapabilities(client: DockerClient): {
  readonly capabilities: AdapterCapabilities;
  readonly canPersist: boolean;
} {
  const canPersist =
    client.findContainer !== undefined &&
    client.inspectState !== undefined &&
    client.startContainer !== undefined;
  const supports: ReadonlySet<AdapterCapability> = new Set<AdapterCapability>(
    canPersist ? [...BASE_SUPPORTED, "persistence"] : BASE_SUPPORTED,
  );
  return { capabilities: { supports, priority: 10 }, canPersist };
}

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

function buildAdapter(client: DockerClient, image: string): Result<SandboxAdapter, KoiError> {
  const { capabilities, canPersist } = buildCapabilities(client);

  const create = async (profile: SandboxProfile): Promise<SandboxInstance> => {
    const mapping = mapProfileToDockerOpts(profile, image);
    if (!mapping.ok) {
      throw new Error(`Invalid profile: ${mapping.error.message}`, { cause: mapping.error });
    }
    const container = await client.createContainer(mapping.value.opts);
    return createDockerInstance(container);
  };

  const adapter: SandboxAdapter = {
    name: "docker",
    version: "0.1.0",
    capabilities,
    create,
    ...(canPersist
      ? {
          findOrCreate: async (
            scope: string,
            profile: SandboxProfile,
          ): Promise<SandboxInstance> => {
            // We've already checked canPersist; the assertions are local invariants.
            const findContainer = client.findContainer;
            const inspectState = client.inspectState;
            const startContainer = client.startContainer;
            if (
              findContainer === undefined ||
              inspectState === undefined ||
              startContainer === undefined
            ) {
              throw new Error("sandbox-docker: persistence path invoked without client support");
            }

            const labels = { [SCOPE_LABEL]: scope };
            const existing = await findContainer(labels);
            if (existing !== undefined) {
              const state = await inspectState(existing.id);
              if (state === "running") {
                return createDockerInstance(existing);
              }
              if (state === "exited" || state === "stopped") {
                await startContainer(existing.id);
                return createDockerInstance(existing);
              }
              // "dead" or "unknown" → fall through and create a fresh container.
            }

            const mapping = mapProfileToDockerOpts(profile, image);
            if (!mapping.ok) {
              throw new Error(`Invalid profile: ${mapping.error.message}`, {
                cause: mapping.error,
              });
            }
            const opts: DockerCreateOpts = {
              ...mapping.value.opts,
              labels: { ...(mapping.value.opts.labels ?? {}), ...labels },
            };
            const container = await client.createContainer(opts);
            return createDockerInstance(container);
          },
        }
      : {}),
  };

  return { ok: true, value: adapter };
}
