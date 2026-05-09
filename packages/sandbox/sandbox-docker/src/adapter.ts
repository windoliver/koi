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
import { deriveScopeContainerName } from "./scope-name.js";
import {
  type DockerAdapterConfig,
  type DockerClient,
  type DockerCreateOpts,
  isDockerNameConflictError,
} from "./types.js";
import { validateDockerConfig } from "./validate.js";

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

function buildAdapter(client: DockerClient, image: string): Result<DockerSandboxAdapter, KoiError> {
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
            serializeScope(scope, () => doFindOrCreate(client, image, scope, profile)),
          destroyScope: (scope: string): Promise<boolean> =>
            // Serialize destroyScope through the same chain so concurrent
            // findOrCreate/destroyScope cannot leave the scope in a half-state.
            serializeScope(scope, () => doDestroyScope(client, scope)),
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
  const findContainers = client.findContainers;
  const inspectContainer = client.inspectContainer;
  const startContainer = client.startContainer;
  if (
    findContainers === undefined ||
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

  // Resolve image to its immutable content-addressed ID so the fingerprint
  // covers tag→digest changes (e.g. `my-image:latest` repointed at new content).
  // Optional: when the client doesn't expose resolveImageId or returns
  // undefined (image not pulled locally), we degrade to (image-string, profile)
  // only — the rest of the flow still works.
  const imageId =
    client.resolveImageId !== undefined ? await client.resolveImageId(image) : undefined;
  const fingerprint = computeProfileFingerprint(profile, image, imageId);
  const scopeLabels: Readonly<Record<string, string>> = { [SCOPE_LABEL]: scope };
  const containerName = deriveScopeContainerName(scope);

  // First reuse attempt before issuing a create — common path is "scope already
  // exists, reattach". The same logic also runs after a name-conflict retry
  // below, so we factor it out.
  const reused = await tryReuse(
    findContainers,
    inspectContainer,
    startContainer,
    scopeLabels,
    fingerprint,
    scope,
  );
  if (reused !== undefined) return reused;

  const opts: DockerCreateOpts = {
    ...mapping.value.opts,
    labels: {
      ...(mapping.value.opts.labels ?? {}),
      ...scopeLabels,
      [PROFILE_HASH_LABEL]: fingerprint,
    },
    name: containerName,
  };
  try {
    const container = await client.createContainer(opts);
    return createDockerInstance(container);
  } catch (e: unknown) {
    if (!isDockerNameConflictError(e)) throw e;
    // We lost the cross-process race: another adapter created the scoped
    // container with the same deterministic name. Re-query and reattach to
    // the winner — this also runs the profile-hash check, so a winner with a
    // stale profile still surfaces a VALIDATION error rather than silently
    // attaching to it.
    const winner = await tryReuse(
      findContainers,
      inspectContainer,
      startContainer,
      scopeLabels,
      fingerprint,
      scope,
    );
    if (winner !== undefined) return winner;
    // Name was taken but no scope-labeled container is reachable — surface
    // the original conflict so the caller can investigate (e.g. a non-koi
    // container squatting on the deterministic name).
    throw e;
  }
}

/**
 * Attempt to reuse an existing scoped container. Returns a SandboxInstance on
 * success, `undefined` when nothing usable exists (no-find, dead, or vanished
 * between find and inspect — the caller should fall through to create).
 *
 * Throws a typed VALIDATION error when:
 *   - more than one container carries the scope label (ambiguity → operator
 *     must clean up via destroyScope), or
 *   - the matched container's recorded profile fingerprint differs from the
 *     request (drift → operator must destroyScope or pick a new scope).
 */
async function tryReuse(
  findContainers: NonNullable<DockerClient["findContainers"]>,
  inspectContainer: NonNullable<DockerClient["inspectContainer"]>,
  startContainer: NonNullable<DockerClient["startContainer"]>,
  scopeLabels: Readonly<Record<string, string>>,
  fingerprint: string,
  scope: string,
): Promise<SandboxInstance | undefined> {
  const matches = await findContainers(scopeLabels);
  if (matches.length === 0) return undefined;

  if (matches.length > 1) {
    // Ambiguity: two or more containers share the scope label. This shouldn't
    // happen under normal operation (deterministic --name + per-scope serializer
    // prevent it within a single adapter; the daemon prevents cross-process
    // duplicates of the named container) but can arise from manual cloning,
    // direct docker commands, or a label being applied out-of-band. Fail closed
    // and direct the operator at the recovery path.
    const error: KoiError = {
      code: "VALIDATION",
      message: `sandbox-docker: scope "${scope}" matches ${matches.length} containers (expected 1); call adapter.destroyScope("${scope}") to remove ALL stale containers for this scope, then retry findOrCreate`,
      retryable: false,
      context: {
        scope,
        ambiguousContainerIds: matches.map((c) => c.id),
      },
    };
    throw new Error(error.message, { cause: error });
  }

  const existing = matches[0];
  if (existing === undefined) return undefined;
  const info = await inspectContainer(existing.id);
  // info === undefined: container vanished between find and inspect.
  // "dead"/"unknown": cannot be reattached. In all three cases the prior
  // container is unusable so the caller should fall through to a fresh create
  // rather than fail closed — there is nothing to reattach to.
  const reusable =
    info !== undefined &&
    (info.state === "running" || info.state === "exited" || info.state === "stopped");
  if (!reusable || info === undefined) return undefined;

  const recordedHash = info.labels[PROFILE_HASH_LABEL];
  if (recordedHash !== fingerprint) {
    // Fail closed. Recovery path: the concrete `DockerSandboxAdapter` exposes
    // `destroyScope(scope)` so the caller can explicitly remove the stale
    // container and re-issue `findOrCreate` once the policy change is
    // intentional. We point at that method by name in the message.
    const error: KoiError = {
      code: "VALIDATION",
      message: `sandbox-docker: scope "${scope}" was created with a different profile (recorded ${recordedHash ?? "<none>"}, requested ${fingerprint}); call adapter.destroyScope("${scope}") to remove the stale sandbox, then retry findOrCreate, or pick a different scope key`,
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

/**
 * Stop and remove ALL containers carrying the scope label. Returns true when
 * any container was destroyed, false when nothing matched.
 *
 * Removing every match (rather than just the first) is intentional: the
 * `tryReuse` ambiguity error explicitly tells operators that destroyScope
 * clears stale siblings for this scope. If we only removed one, a follow-up
 * findOrCreate could still encounter the leftover — leaving the scope
 * permanently poisoned. Best-effort: each container's stop/remove failure is
 * captured; after attempting them all we surface the first error.
 */
async function doDestroyScope(client: DockerClient, scope: string): Promise<boolean> {
  const findContainers = client.findContainers;
  if (findContainers === undefined) return false;
  const matches = await findContainers({ [SCOPE_LABEL]: scope });
  if (matches.length === 0) return false;

  // `let` justified: capture the first failure across the loop so we attempt
  // every cleanup before surfacing.
  let firstError: unknown;
  for (const c of matches) {
    try {
      await c.stop();
    } catch (e: unknown) {
      if (firstError === undefined) firstError = e;
    }
    try {
      await c.remove();
    } catch (e: unknown) {
      if (firstError === undefined) firstError = e;
    }
  }
  if (firstError !== undefined) throw firstError;
  return true;
}
