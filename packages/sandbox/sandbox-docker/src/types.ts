/**
 * Internal Docker adapter types. Public adapter is exported via index.ts.
 */

export interface DockerExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when stdout or stderr was truncated due to maxOutputBytes. */
  readonly truncated?: boolean;
}

export interface DockerExecOpts {
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  /** Working directory inside the container. */
  readonly cwd?: string;
  /** Maximum bytes to buffer for stdout + stderr combined. */
  readonly maxOutputBytes?: number;
  /** Optional AbortSignal — when aborted, kills the docker exec subprocess. */
  readonly signal?: AbortSignal;
}

export interface DockerContainer {
  readonly id: string;
  readonly exec: (cmd: string, opts?: DockerExecOpts) => Promise<DockerExecResult>;
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly writeFile: (path: string, content: Uint8Array) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly remove: () => Promise<void>;
  /**
   * Detach from the container without removing it: stop only.
   * The container survives so a later `findOrCreate(scope)` can reattach.
   * Optional — only present on containers produced via the persistence path.
   */
  readonly detach?: (() => Promise<void>) | undefined;
}

export interface DockerCreateOpts {
  readonly image: string;
  readonly networkMode: "none" | "bridge";
  readonly env?: Readonly<Record<string, string>>;
  readonly memoryMb?: number;
  readonly pidsLimit?: number;
  readonly binds?: readonly string[];
  readonly capAdd?: readonly string[];
  /**
   * When true, passes `--read-only` to docker create so the container rootfs
   * is read-only. Only the explicit bind mounts are writable. Use in combination
   * with tmpfsMounts to provide scratch space (e.g., /tmp).
   */
  readonly readOnlyRoot?: boolean;
  /**
   * Paths inside the container to mount as tmpfs (e.g., ["/tmp"]).
   * Each entry is passed as `--tmpfs <path>`. Ignored when readOnlyRoot is false.
   */
  readonly tmpfsMounts?: readonly string[];
  /**
   * Optional Docker labels applied at create time (`--label key=value`).
   * Used by the persistence path to tag a container with its scope so a later
   * `findOrCreate(scope)` can locate it.
   */
  readonly labels?: Readonly<Record<string, string>>;
  /**
   * Optional deterministic container name (`--name <name>`). The persistence
   * path derives a name from the scope key so Docker enforces cross-process
   * uniqueness — two adapters racing `findOrCreate(scope)` cannot both
   * succeed. The loser receives a name-conflict error and the adapter
   * re-queries to attach to the winner. See `scope-name.ts`.
   */
  readonly name?: string;
}

/**
 * Sentinel marker attached to errors thrown by `createContainer` when Docker
 * rejects a `--name` due to an existing container claiming the same name.
 * The persistence adapter catches this to convert "I lost the race" into
 * "let me find and reattach to the winner".
 */
export const DOCKER_NAME_CONFLICT_CODE = "DOCKER_NAME_CONFLICT" as const;

export interface DockerNameConflictError extends Error {
  readonly code: typeof DOCKER_NAME_CONFLICT_CODE;
}

export function isDockerNameConflictError(e: unknown): e is DockerNameConflictError {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: string }).code === DOCKER_NAME_CONFLICT_CODE
  );
}

/** Lifecycle state of an existing container, normalized across docker versions. */
export type DockerContainerState = "running" | "exited" | "stopped" | "dead" | "unknown";

/** Inspect snapshot of an existing container — state plus declared labels. */
export interface DockerContainerInfo {
  readonly state: DockerContainerState;
  readonly labels: Readonly<Record<string, string>>;
}

export interface DockerClient {
  readonly createContainer: (opts: DockerCreateOpts) => Promise<DockerContainer>;
  /**
   * Enumerate ALL containers matching the given label set. Returns an empty
   * array when none match. Returning the full list (instead of just the
   * "first" match) lets the persistence adapter detect ambiguous scopes —
   * two containers carrying the same scope label is a recoverable invariant
   * violation rather than a silent split-brain.
   *
   * Optional — clients without a persistence story omit this; the adapter
   * treats persistence as unavailable when any of findContainers /
   * inspectContainer / startContainer is missing.
   */
  readonly findContainers?:
    | ((labels: Readonly<Record<string, string>>) => Promise<readonly DockerContainer[]>)
    | undefined;
  /**
   * Inspect lifecycle state + labels of a container by id. Returns `undefined`
   * when the container no longer exists (for example, racy removal between
   * `findContainers` and `inspectContainer`). The adapter treats `undefined` as
   * "create fresh" rather than throwing so a missing container does not block
   * persistence resumption.
   */
  readonly inspectContainer?:
    | ((id: string) => Promise<DockerContainerInfo | undefined>)
    | undefined;
  /** Start a stopped container (no-op if already running). */
  readonly startContainer?: ((id: string) => Promise<void>) | undefined;
  /**
   * Resolve a Docker image reference (`name:tag` or digest) to its immutable
   * content-addressed image ID (e.g. `sha256:abc...`). Returns `undefined`
   * when the image is not pulled locally and cannot be resolved without a
   * network call — the adapter treats undefined as "skip image-ID drift
   * check" so an offline or unknown image does not block persistence.
   *
   * The persistence path includes this ID in the profile fingerprint so a
   * mutable tag (`my-image:latest`) repointed at new content invalidates the
   * stored fingerprint and triggers fail-closed drift detection — instead of
   * silently reattaching to a container running the old root filesystem.
   *
   * Optional. When absent, the fingerprint covers (image-string, profile)
   * only and version skew behind a mutable tag will not be detected.
   */
  readonly resolveImageId?: ((imageRef: string) => Promise<string | undefined>) | undefined;
}

export interface DockerAdapterConfig {
  readonly socketPath?: string;
  readonly image?: string;
  readonly client?: DockerClient;
  /**
   * Optional probe function injected for testing.
   * Defaults to running `docker version` via detectDocker().
   * Only used when client is not provided (the availability-probe code path).
   */
  readonly probe?: () => Promise<number>;
  /**
   * Optional ScopeRegistry for the persistence path. Reuse trusts only
   * containers whose IDs were previously recorded by THIS registry — a
   * peer process or attacker that can fabricate matching `koi.sandbox.*`
   * labels cannot hijack a scope, because their container's ID will not
   * match the recorded one.
   *
   * Defaults to a file-backed registry at
   * `${KOI_SANDBOX_DOCKER_STATE_DIR}/scopes.json` (or
   * `${XDG_STATE_HOME ?? ~/.local/state}/koi-sandbox-docker/scopes.json`).
   * Pass `createInMemoryScopeRegistry()` for tests or short-lived adapters.
   */
  readonly scopeRegistry?: import("./scope-registry.js").ScopeRegistry;
}

export interface ResolvedDockerConfig {
  readonly socketPath: string;
  readonly image: string;
  readonly client: DockerClient;
}
