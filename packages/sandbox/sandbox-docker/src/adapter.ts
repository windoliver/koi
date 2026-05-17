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
import { doDestroyScope, doFindOrCreate } from "./find-or-create.js";
import { createDockerInstance } from "./instance.js";
import { mapProfileToDockerOpts } from "./profile-to-opts.js";
import { createFileScopeRegistry, type ScopeRegistry } from "./scope-registry.js";
import type { DockerAdapterConfig, DockerClient } from "./types.js";
import { validateDockerConfig, validateDockerImage } from "./validate.js";

/**
 * Concrete docker adapter type — extends the L0 SandboxAdapter with adapter-
 * specific scope management. Returned by `createDockerAdapter` so callers that
 * hold the concrete type can recover from profile drift by destroying the
 * prior scoped sandbox without going out-of-band to the docker CLI.
 */
export interface DockerSandboxAdapter extends SandboxAdapter {
  /**
   * Stop and remove any container previously created by `findOrCreate(scope)`.
   * Returns `true` when a scoped container was found and removed, `false`
   * when nothing matched. No-op when persistence is unavailable. Use this to
   * recover from a `findOrCreate` profile-drift VALIDATION error: destroy the
   * stale scoped sandbox, then call `findOrCreate(scope, ...)` again.
   *
   * Optional — only present when the underlying DockerClient supports the
   * persistence triple.
   */
  readonly destroyScope?: (scope: string) => Promise<boolean>;
}

/**
 * Adapter capabilities depend on whether the underlying DockerClient supports
 * the persistence triple (findContainer + inspectContainer + startContainer).
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
    client.findContainers !== undefined &&
    client.inspectContainer !== undefined &&
    client.startContainer !== undefined;
  const supports: ReadonlySet<AdapterCapability> = new Set<AdapterCapability>(
    canPersist ? [...BASE_SUPPORTED, "persistence"] : BASE_SUPPORTED,
  );
  return { capabilities: { supports, priority: 10 }, canPersist };
}

/**
 * Per-scope serializer. Concurrent `findOrCreate(scope, ...)` calls must run
 * sequentially so the check-then-create window cannot fork one scope into two
 * containers. The chain is kept per adapter instance — cross-process or
 * cross-adapter dedupe still relies on Docker's labels (and is best-effort);
 * callers that need cross-process exclusivity must coordinate externally.
 */
function createScopeSerializer(): <T>(scope: string, fn: () => Promise<T>) => Promise<T> {
  const chain = new Map<string, Promise<unknown>>();
  return <T>(scope: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chain.get(scope) ?? Promise.resolve();
    // `then(fn, fn)` keeps the chain live even if a previous turn rejected,
    // so one failed reattach does not deadlock subsequent calls.
    const next = prev.then(fn, fn);
    chain.set(
      scope,
      next.catch(() => undefined),
    );
    return next as Promise<T>;
  };
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
): Promise<Result<DockerSandboxAdapter, KoiError>> {
  // Default: file-backed registry on disk (cross-process safe). Tests/short-lived
  // adapters can inject createInMemoryScopeRegistry() instead.
  const scopeRegistry: ScopeRegistry = config.scopeRegistry ?? createFileScopeRegistry();

  // Fast path: client already provided — skip probe.
  if (config.client !== undefined) {
    const validated = validateDockerConfig(config);
    if (!validated.ok) return validated;
    const { client, image } = validated.value;
    return buildAdapter(client, image, scopeRegistry);
  }

  const image = (config.image ?? "ubuntu:22.04").trim();
  const imageError = validateDockerImage(image);
  if (imageError !== undefined) {
    return { ok: false, error: imageError };
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
  return buildAdapter(client, image, scopeRegistry);
}

function buildAdapter(
  client: DockerClient,
  image: string,
  scopeRegistry: ScopeRegistry,
): Result<DockerSandboxAdapter, KoiError> {
  const { capabilities, canPersist } = buildCapabilities(client);
  const serializeScope = createScopeSerializer();

  const create = async (profile: SandboxProfile): Promise<SandboxInstance> => {
    const mapping = mapProfileToDockerOpts(profile, image);
    if (!mapping.ok) {
      throw new Error(`Invalid profile: ${mapping.error.message}`, { cause: mapping.error });
    }
    const container = await client.createContainer(mapping.value.opts);
    return createDockerInstance(container);
  };

  const adapter: DockerSandboxAdapter = {
    name: "docker",
    version: "0.1.0",
    capabilities,
    create,
    ...(canPersist
      ? {
          findOrCreate: (scope: string, profile: SandboxProfile): Promise<SandboxInstance> =>
            // Per-scope serialization closes the check-then-create race that
            // would otherwise let two concurrent callers fork a scope into two
            // containers within the same adapter instance. Cross-process races
            // are handled by the deterministic container name + name-conflict
            // retry inside `doFindOrCreate`.
            serializeScope(scope, () =>
              doFindOrCreate(client, image, scope, profile, scopeRegistry),
            ),
          destroyScope: (scope: string): Promise<boolean> =>
            // Serialize destroyScope through the same chain so concurrent
            // findOrCreate/destroyScope cannot leave the scope in a half-state.
            serializeScope(scope, () => doDestroyScope(client, scope, scopeRegistry)),
        }
      : {}),
  };

  return { ok: true, value: adapter };
}
