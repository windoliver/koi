import type { KoiError, SandboxInstance, SandboxProfile } from "@koi/core";
import { computeProfileFingerprint } from "./fingerprint.js";
import { createDockerInstance } from "./instance.js";
import { mapProfileToDockerOpts } from "./profile-to-opts.js";
import { deriveScopeContainerName } from "./scope-name.js";
import type { ScopeRegistry } from "./scope-registry.js";
import {
  type DockerClient,
  type DockerContainer,
  type DockerContainerInfo,
  type DockerCreateOpts,
  isDockerNameConflictError,
} from "./types.js";

/** Label key used to tag containers with their persistence scope. */
export const SCOPE_LABEL = "koi.sandbox.scope";
/**
 * Label key used to tag containers with the fingerprint of (image, profile)
 * they were created with. Verified before reattach so a profile change cannot
 * silently grant the caller a sandbox that no longer matches the new policy.
 */
export const PROFILE_HASH_LABEL = "koi.sandbox.profile-hash";

interface ReuseArgs {
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
}

export async function doFindOrCreate(
  client: DockerClient,
  image: string,
  scope: string,
  profile: SandboxProfile,
  scopeRegistry: ScopeRegistry,
): Promise<SandboxInstance> {
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

  const mapping = mapProfileToDockerOpts(profile, image);
  if (!mapping.ok) {
    throw new Error(`Invalid profile: ${mapping.error.message}`, { cause: mapping.error });
  }

  // Resolve image to its immutable content-addressed ID so the fingerprint
  // covers tag→digest changes (e.g. `my-image:latest` repointed at new content).
  const imageId =
    client.resolveImageId !== undefined ? await client.resolveImageId(image) : undefined;
  const fingerprint = computeProfileFingerprint(profile, image, imageId);
  const scopeLabels: Readonly<Record<string, string>> = { [SCOPE_LABEL]: scope };
  const containerName = deriveScopeContainerName(scope);

  const reuseArgs: ReuseArgs = {
    findContainers,
    inspectContainer,
    startContainer,
    scopeLabels,
    fingerprint,
    scope,
    scopeRegistry,
    unownedAction: "throw",
  };
  const reused = await tryReuse(reuseArgs);
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
    try {
      await scopeRegistry.record(scope, container.id);
    } catch (recordErr: unknown) {
      // Roll back the create so a wedged scope (name held but no registry
      // entry) does not block subsequent attempts after a transient registry
      // I/O failure.
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
    // Lost cross-process race OR squatter on the deterministic name. The
    // winner peer's `record()` may not have landed yet; bounded retry covers
    // that window without false-positive "stranger" failures.
    const winner = await tryReuseWithRetry(
      { ...reuseArgs, unownedAction: "skip" },
      { attempts: 5, delayMs: 100 },
    );
    if (winner !== undefined) return winner;
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
 * Trust-check label matches and pick the single owned container (if any).
 * Returns the owned `DockerContainer`, or undefined when no usable match
 * exists. Throws a typed VALIDATION error on ambiguity, definitive stranger
 * mismatch, or (when unownedAction === "throw") an unowned label squatter.
 */
async function selectOwnedMatch(
  matches: readonly DockerContainer[],
  scope: string,
  scopeRegistry: ScopeRegistry,
  unownedAction: "throw" | "skip",
): Promise<DockerContainer | undefined> {
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    const error: KoiError = {
      code: "VALIDATION",
      message: `sandbox-docker: scope "${scope}" matches ${matches.length} containers (expected 1); call adapter.destroyScope("${scope}") to remove ALL stale containers for this scope, then retry findOrCreate`,
      retryable: false,
      context: { scope, ambiguousContainerIds: matches.map((c) => c.id) },
    };
    throw new Error(error.message, { cause: error });
  }
  const existing = matches[0];
  if (existing === undefined) return undefined;

  const expectedId = await scopeRegistry.lookup(scope);
  if (expectedId === undefined) {
    if (unownedAction === "throw") {
      const error: KoiError = {
        code: "VALIDATION",
        message: `sandbox-docker: scope "${scope}" is already claimed by container ${existing.id} which we do not own (no registry entry); refusing to create a duplicate scope-labeled container — investigate via 'docker ps -a --filter label=${SCOPE_LABEL}=${scope}' and remove manually if appropriate`,
        retryable: false,
        context: { scope, existingContainerId: existing.id },
      };
      throw new Error(error.message, { cause: error });
    }
    return undefined;
  }
  if (expectedId !== existing.id) {
    const error: KoiError = {
      code: "VALIDATION",
      message: `sandbox-docker: scope "${scope}" is claimed by container ${existing.id} but we recorded ${expectedId} — refusing to attach to an unverified container; investigate via 'docker ps -a --filter label=${SCOPE_LABEL}=${scope}' and remove manually if appropriate`,
      retryable: false,
      context: { scope, existingContainerId: existing.id, recordedContainerId: expectedId },
    };
    throw new Error(error.message, { cause: error });
  }
  return existing;
}

/**
 * Resolve the inspected container into a reuse decision: drift error, stale
 * cleanup (returns undefined), or live SandboxInstance.
 */
async function reuseInspected(
  existing: DockerContainer,
  info: DockerContainerInfo,
  scope: string,
  fingerprint: string,
  scopeRegistry: ScopeRegistry,
  startContainer: NonNullable<DockerClient["startContainer"]>,
): Promise<SandboxInstance | undefined> {
  if (info.state === "dead" || info.state === "unknown") {
    try {
      await existing.remove();
    } catch {
      // Best-effort: a follow-up create will surface name-conflict if needed.
    }
    await scopeRegistry.forgetIfMatches(scope, existing.id);
    return undefined;
  }
  const recordedHash = info.labels[PROFILE_HASH_LABEL];
  if (recordedHash !== fingerprint) {
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
  if (info.state === "running") return createDockerInstance(existing);
  await startContainer(existing.id);
  return createDockerInstance(existing);
}

async function tryReuse(args: ReuseArgs): Promise<SandboxInstance | undefined> {
  const matches = await args.findContainers(args.scopeLabels);
  const existing = await selectOwnedMatch(
    matches,
    args.scope,
    args.scopeRegistry,
    args.unownedAction,
  );
  if (existing === undefined) return undefined;

  const info = await args.inspectContainer(existing.id);
  if (info === undefined) {
    // Container vanished between find and inspect. CAS-forget so a peer that
    // recorded a replacement between our lookup and this cleanup is preserved.
    await args.scopeRegistry.forgetIfMatches(args.scope, existing.id);
    return undefined;
  }
  return reuseInspected(
    existing,
    info,
    args.scope,
    args.fingerprint,
    args.scopeRegistry,
    args.startContainer,
  );
}

async function tryReuseWithRetry(
  args: ReuseArgs,
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

export async function doDestroyScope(
  client: DockerClient,
  scope: string,
  scopeRegistry: ScopeRegistry,
): Promise<boolean> {
  const findContainers = client.findContainers;
  if (findContainers === undefined) return false;

  const ownedId = await scopeRegistry.lookup(scope);
  const matches = await findContainers({ [SCOPE_LABEL]: scope });

  if (ownedId === undefined) {
    if (matches.length > 0) {
      const error: KoiError = {
        code: "VALIDATION",
        message: `sandbox-docker: destroyScope("${scope}") found ${matches.length} container(s) carrying the scope label but no registry entry — refusing to delete containers we do not own; investigate via 'docker ps -a --filter label=${SCOPE_LABEL}=${scope}' and remove manually if appropriate`,
        retryable: false,
        context: { scope, unownedContainerIds: matches.map((c) => c.id) },
      };
      throw new Error(error.message, { cause: error });
    }
    return false;
  }

  const owned = matches.find((c) => c.id === ownedId);
  const strangers = matches.filter((c) => c.id !== ownedId);

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
    await owned.remove();
  }
  await scopeRegistry.forgetIfMatches(scope, ownedId);
  return owned !== undefined;
}
