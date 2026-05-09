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
import { createFileScopeRegistry, type ScopeRegistry } from "./scope-registry.js";
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

async function doFindOrCreate(
  client: DockerClient,
  image: string,
  scope: string,
  profile: SandboxProfile,
  scopeRegistry: ScopeRegistry,
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

  // First reuse attempt: only honors a registry-recorded ID, so a peer that
  // can fabricate scope/hash labels cannot hijack the scope. Common path is
  // "scope already exists, reattach". The same logic also runs after a
  // name-conflict retry below, so we factor it out.
  const reused = await tryReuse({
    findContainers,
    inspectContainer,
    startContainer,
    scopeLabels,
    fingerprint,
    scope,
    scopeRegistry,
    // Pre-create: refuse to make a duplicate scope-labeled container if any
    // unowned label match exists. This is the trust-boundary check that
    // blocks delayed-DoS via label squatting.
    unownedAction: "throw",
  });
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
    // Record the ID we received so subsequent reuse trusts only this exact
    // container (forgery-resistant: the registry is private to this process /
    // host, not a label set anyone with daemon access can write).
    try {
      await scopeRegistry.record(scope, container.id);
    } catch (recordErr: unknown) {
      // The registry write failed (disk full, perms, transient I/O). The
      // container exists and holds the deterministic --name, so without this
      // cleanup the scope would wedge: every subsequent findOrCreate would
      // see the name conflict but find no matching registry entry and
      // refuse to attach (security correct, availability bad). Roll back
      // the create so the next attempt starts from a clean slate.
      try {
        await container.remove();
      } catch {
        // Best effort: surface the original record error either way.
      }
      throw recordErr;
    }
    return createDockerInstance(container);
  } catch (e: unknown) {
    if (!isDockerNameConflictError(e)) throw e;
    // We lost the cross-process race OR an attacker / stale dead container is
    // squatting on the deterministic name. Decide which by consulting the
    // registry: only reattach if the surviving container's ID matches a
    // value WE previously recorded.
    //
    // Important: a peer process that won the race may not have called
    // `scopeRegistry.record` yet — there is a non-zero window between
    // `createContainer` returning on the winner and the winner's record()
    // landing on disk. Bounded retry covers that window without forcing
    // the legitimate loser into a false-positive "stranger" failure.
    const winner = await tryReuseWithRetry(
      {
        findContainers,
        inspectContainer,
        startContainer,
        scopeLabels,
        fingerprint,
        scope,
        scopeRegistry,
        // Post-conflict retry: the winner peer's `record()` may not have
        // landed yet, so a missing entry is recoverable — keep retrying
        // rather than failing closed on the first miss.
        unownedAction: "skip",
      },
      { attempts: 5, delayMs: 100 },
    );
    if (winner !== undefined) return winner;
    // Name was taken but the surviving container is not one we own. Refuse
    // to attach to a stranger and surface the original conflict so the
    // caller knows the scope is being held by something they need to clean
    // up (manual `docker rm`, or a separate Koi instance with its own
    // registry).
    const error: KoiError = {
      code: "VALIDATION",
      message: `sandbox-docker: container name "${containerName}" for scope "${scope}" is already in use by a container we do not own (no matching entry in the scope registry); refusing to reattach to an unverified container — investigate via 'docker ps -a --filter name=${containerName}' and remove it manually if appropriate`,
      retryable: false,
      context: { scope, containerName },
    };
    throw new Error(error.message, { cause: e });
  }
}

/**
 * Attempt to reuse an existing scoped container. Returns a SandboxInstance on
 * success, `undefined` when nothing usable exists.
 *
 * Reuse trust model: the caller's process must have previously recorded the
 * container ID via `scopeRegistry.record` (private state, not a forgeable
 * label). If the daemon-side scope-labeled container's ID does not match the
 * recorded ID, we treat the daemon container as a stranger and refuse to
 * reattach to it. This blocks a peer with daemon access from hijacking a
 * scope by fabricating the public `koi.sandbox.scope`/`koi.sandbox.profile-hash`
 * labels.
 *
 * Side effects:
 *   - dead/unknown matched container is auto-removed and the registry entry
 *     forgotten so the next create can reuse the deterministic --name (this
 *     prevents the scope from wedging on a dead container).
 *
 * Throws a typed VALIDATION error when:
 *   - more than one container carries the scope label (ambiguity → operator
 *     must clean up via destroyScope), or
 *   - the matched container's recorded profile fingerprint differs from the
 *     request (drift → operator must destroyScope or pick a new scope).
 */
async function tryReuse(args: {
  readonly findContainers: NonNullable<DockerClient["findContainers"]>;
  readonly inspectContainer: NonNullable<DockerClient["inspectContainer"]>;
  readonly startContainer: NonNullable<DockerClient["startContainer"]>;
  readonly scopeLabels: Readonly<Record<string, string>>;
  readonly fingerprint: string;
  readonly scope: string;
  readonly scopeRegistry: ScopeRegistry;
  /**
   * What to do when a label-matching container exists but the registry has
   * no entry for the scope.
   * - "throw": fail closed (pre-create path — refuse to make a duplicate
   *   scope-labeled container alongside a stranger).
   * - "skip": return undefined so the caller's retry loop can wait for the
   *   winner peer's `record()` to land (post-name-conflict path).
   */
  readonly unownedAction: "throw" | "skip";
}): Promise<SandboxInstance | undefined> {
  const {
    findContainers,
    inspectContainer,
    startContainer,
    scopeLabels,
    fingerprint,
    scope,
    scopeRegistry,
  } = args;
  const matches = await findContainers(scopeLabels);
  if (matches.length === 0) return undefined;

  if (matches.length > 1) {
    // Ambiguity: two or more containers share the scope label. This shouldn't
    // happen under normal operation but can arise from manual cloning, direct
    // docker commands, or a label being applied out-of-band. Fail closed and
    // direct the operator at the recovery path.
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

  // Trust check: only reattach to a container ID we ourselves recorded for
  // this scope. A peer that fabricated the scope label has no way to write
  // to our private registry, so an ID mismatch (or a missing registry entry)
  // means the matched container is not ours.
  const expectedId = await scopeRegistry.lookup(scope);
  if (expectedId === undefined) {
    if (args.unownedAction === "throw") {
      // A label-matching container exists but no registry entry → not ours.
      // Returning undefined here would let `doFindOrCreate` proceed to
      // fresh-create and produce a SECOND container carrying the same scope
      // label — which the next call would trip on the multi-match ambiguity
      // path, wedging the scope behind manual cleanup. Fail closed now so
      // the operator gets one actionable error instead of a delayed DoS.
      const error: KoiError = {
        code: "VALIDATION",
        message: `sandbox-docker: scope "${scope}" is already claimed by container ${existing.id} which we do not own (no registry entry); refusing to create a duplicate scope-labeled container — investigate via 'docker ps -a --filter label=${SCOPE_LABEL}=${scope}' and remove manually if appropriate`,
        retryable: false,
        context: { scope, existingContainerId: existing.id },
      };
      throw new Error(error.message, { cause: error });
    }
    // unownedAction === "skip": let the caller decide. Used by the post-name-
    // conflict retry loop where the winner peer's `record()` may not have
    // landed yet, so a temporarily-missing entry is recoverable not fatal.
    return undefined;
  }
  if (expectedId !== existing.id) {
    // Definitive stranger: we recorded a different ID, so the daemon-side
    // scope-labeled container is not ours. Always fail closed — no retry
    // window can change this.
    const error: KoiError = {
      code: "VALIDATION",
      message: `sandbox-docker: scope "${scope}" is claimed by container ${existing.id} but we recorded ${expectedId} — refusing to attach to an unverified container; investigate via 'docker ps -a --filter label=${SCOPE_LABEL}=${scope}' and remove manually if appropriate`,
      retryable: false,
      context: { scope, existingContainerId: existing.id, recordedContainerId: expectedId },
    };
    throw new Error(error.message, { cause: error });
  }

  const info = await inspectContainer(existing.id);
  // info === undefined: container vanished between find and inspect. CAS-
  // forget so a peer that recorded a replacement between our lookup and
  // this cleanup is not silently de-trusted.
  if (info === undefined) {
    await scopeRegistry.forgetIfMatches(scope, existing.id);
    return undefined;
  }

  // dead/unknown: container can't be reattached AND its --name still binds
  // the scope. Auto-remove so the subsequent create can reuse the name —
  // otherwise the scope wedges permanently on the dead container.
  if (info.state === "dead" || info.state === "unknown") {
    try {
      await existing.remove();
    } catch {
      // Best-effort: if remove fails, the create will throw a name-conflict
      // and the caller will get an actionable error.
    }
    // CAS-forget by id so a peer's freshly-recorded replacement (between
    // our lookup and this cleanup) is preserved instead of silently erased.
    await scopeRegistry.forgetIfMatches(scope, existing.id);
    return undefined;
  }

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
 * Wrap `tryReuse` with bounded retries — used after losing the deterministic
 * name-conflict race so the winner has time to land its `scopeRegistry.record`
 * write. Without retry, a perfectly legitimate loser would see "container
 * exists but registry doesn't know it" and falsely reject the winner.
 *
 * Bounded so a genuine stranger (label squatter, leftover from a peer with
 * its own registry) still surfaces the security failure quickly instead of
 * stalling indefinitely.
 */
async function tryReuseWithRetry(
  args: Parameters<typeof tryReuse>[0],
  policy: { readonly attempts: number; readonly delayMs: number },
): Promise<SandboxInstance | undefined> {
  for (let i = 0; i < policy.attempts; i++) {
    const out = await tryReuse(args);
    if (out !== undefined) return out;
    if (i < policy.attempts - 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, policy.delayMs);
      });
    }
  }
  return undefined;
}

/**
 * Remove the container WE OWN for a scope, then forget the registry entry.
 * Returns true when the owned container was destroyed, false when no
 * registry entry exists (nothing to destroy on our side).
 *
 * Ownership-gated: only the container ID we previously recorded via
 * `scopeRegistry.record` is eligible for removal. Other label-matching
 * containers (foreign peers, manually-created leftovers) are NOT touched —
 * `destroyScope` is a recovery primitive, not a cluster-wide rm-by-label.
 * Force-removing a stranger's container by virtue of a public label match
 * would break the same trust boundary the registry exists to enforce.
 *
 * Foreign matches are surfaced as a typed VALIDATION error AFTER the
 * owned container is removed, so the operator learns the scope label
 * needs manual investigation without losing the recovery semantics for
 * the part of the scope we actually owned.
 *
 * Stop is intentionally skipped: `container.remove()` uses `docker rm -f`
 * which force-kills running containers, so a separate `stop()` step is
 * redundant and previously caused destroyScope to surface failure for
 * already-stopped containers (where `docker stop` legitimately errors).
 */
async function doDestroyScope(
  client: DockerClient,
  scope: string,
  scopeRegistry: ScopeRegistry,
): Promise<boolean> {
  const findContainers = client.findContainers;
  if (findContainers === undefined) return false;

  const ownedId = await scopeRegistry.lookup(scope);
  // Discover label-matching containers AFTER reading the registry so a
  // transient `findContainers` failure doesn't leak into the no-owner
  // fast-path below — `findContainers` now throws on docker-side faults.
  const matches = await findContainers({ [SCOPE_LABEL]: scope });

  if (ownedId === undefined) {
    // No registry entry → nothing of ours to remove. We deliberately do NOT
    // touch label-matching strangers here; that would be a label-driven
    // cluster delete and break the trust model. Surface ambiguity so the
    // operator knows manual intervention is needed.
    if (matches.length > 0) {
      const error: KoiError = {
        code: "VALIDATION",
        message: `sandbox-docker: destroyScope("${scope}") found ${matches.length} container(s) carrying the scope label but no registry entry — refusing to delete containers we do not own; investigate via 'docker ps -a --filter label=${SCOPE_LABEL}=${scope}' and remove manually if appropriate`,
        retryable: false,
        context: {
          scope,
          unownedContainerIds: matches.map((c) => c.id),
        },
      };
      throw new Error(error.message, { cause: error });
    }
    return false;
  }

  const owned = matches.find((c) => c.id === ownedId);
  const strangers = matches.filter((c) => c.id !== ownedId);

  // Preflight: when foreign siblings exist alongside our owned container,
  // fail closed BEFORE removing anything. Removing the owned container
  // first would leave the scope wedged on the strangers and the operator
  // would have lost their good sandbox to no benefit. The recovery path
  // is documented as remove-mine + report-the-rest, not partial demolition.
  if (strangers.length > 0) {
    const error: KoiError = {
      code: "VALIDATION",
      message: `sandbox-docker: destroyScope("${scope}") found ${strangers.length} additional container(s) carrying the scope label besides our recorded one — refusing to remove the owned container while strangers remain (would leave the scope wedged); investigate via 'docker ps -a --filter label=${SCOPE_LABEL}=${scope}' and remove the strangers manually before retrying`,
      retryable: false,
      context: {
        scope,
        ownedContainerId: ownedId,
        unownedContainerIds: strangers.map((c) => c.id),
      },
    };
    throw new Error(error.message, { cause: error });
  }

  if (owned !== undefined) {
    // Let any error propagate — ownership is preserved (we have not yet
    // touched the registry on this path) so a future destroyScope can retry.
    await owned.remove();
  }

  // CAS-forget: if a peer process recorded a replacement between our
  // initial lookup and this point (after we removed the old container),
  // their record survives — only our own ownership id is unlinked.
  await scopeRegistry.forgetIfMatches(scope, ownedId);
  return owned !== undefined;
}
