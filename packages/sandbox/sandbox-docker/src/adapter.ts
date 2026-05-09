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
import { computeProfileFingerprint } from "./fingerprint.js";
import { createDockerInstance } from "./instance.js";
import { mapProfileToDockerOpts } from "./profile-to-opts.js";
import type { DockerAdapterConfig, DockerClient, DockerCreateOpts } from "./types.js";
import { validateDockerConfig } from "./validate.js";

/** Label key used to tag containers with their persistence scope. */
const SCOPE_LABEL = "koi.sandbox.scope";
/**
 * Label key used to tag containers with the fingerprint of (image, profile)
 * they were created with. Verified before reattach so a profile change cannot
 * silently grant the caller a sandbox that no longer matches the new policy.
 */
const PROFILE_HASH_LABEL = "koi.sandbox.profile-hash";

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
    client.findContainer !== undefined &&
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
  const serializeScope = createScopeSerializer();

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
          findOrCreate: (scope: string, profile: SandboxProfile): Promise<SandboxInstance> =>
            // Per-scope serialization closes the check-then-create race that
            // would otherwise let two concurrent callers fork a scope into two
            // containers.
            serializeScope(scope, () => doFindOrCreate(client, image, scope, profile)),
        }
      : {}),
  };

  return { ok: true, value: adapter };
}

async function doFindOrCreate(
  client: DockerClient,
  image: string,
  scope: string,
  profile: SandboxProfile,
): Promise<SandboxInstance> {
  // We've already checked canPersist; the local assertions are sanity checks.
  const findContainer = client.findContainer;
  const inspectContainer = client.inspectContainer;
  const startContainer = client.startContainer;
  if (
    findContainer === undefined ||
    inspectContainer === undefined ||
    startContainer === undefined
  ) {
    throw new Error("sandbox-docker: persistence path invoked without client support");
  }

  // Validate the profile up front — fail closed before touching the daemon
  // so a bad profile cannot accidentally reuse a previously valid container.
  const mapping = mapProfileToDockerOpts(profile, image);
  if (!mapping.ok) {
    throw new Error(`Invalid profile: ${mapping.error.message}`, { cause: mapping.error });
  }

  const fingerprint = computeProfileFingerprint(profile, image);
  const scopeLabels: Readonly<Record<string, string>> = { [SCOPE_LABEL]: scope };

  const existing = await findContainer(scopeLabels);
  if (existing !== undefined) {
    const info = await inspectContainer(existing.id);
    // info === undefined means the container vanished between find and
    // inspect; "dead"/"unknown" means it cannot be reattached. In all three
    // cases the prior container is unusable, so we fall through to a fresh
    // create rather than failing closed on the profile mismatch — there is
    // nothing to reattach to.
    const reusable =
      info !== undefined &&
      (info.state === "running" || info.state === "exited" || info.state === "stopped");
    if (reusable && info !== undefined) {
      const recordedHash = info.labels[PROFILE_HASH_LABEL];
      if (recordedHash !== fingerprint) {
        // Fail closed: do NOT silently reattach a container whose stored
        // profile no longer matches the requested one. Caller can resolve by
        // destroying the prior sandbox (via a fresh `create()` flow) or
        // updating the scope. Surfacing this loudly is intentional — the
        // alternative (silent reuse) is the trust-boundary bug we're fixing.
        const error: KoiError = {
          code: "VALIDATION",
          message: `sandbox-docker: scope "${scope}" was created with a different profile (recorded ${recordedHash ?? "<none>"}, requested ${fingerprint}); destroy the prior sandbox or pick a new scope`,
          retryable: false,
          context: {
            scope,
            recordedProfileHash: recordedHash ?? null,
            requestedProfileHash: fingerprint,
          },
        };
        throw new Error(error.message, { cause: error });
      }
      if (info.state === "running") {
        return createDockerInstance(existing);
      }
      // exited or stopped → resume in place.
      await startContainer(existing.id);
      return createDockerInstance(existing);
    }
  }

  const opts: DockerCreateOpts = {
    ...mapping.value.opts,
    labels: {
      ...(mapping.value.opts.labels ?? {}),
      ...scopeLabels,
      [PROFILE_HASH_LABEL]: fingerprint,
    },
  };
  const container = await client.createContainer(opts);
  return createDockerInstance(container);
}
