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
   * Look up a container by exact label match. Returns the most recent matching
   * container (running preferred over stopped) or `undefined` when none exists.
   * Optional — clients without a persistence story omit this; the adapter
   * treats persistence as unavailable when any of findContainer /
   * inspectContainer / startContainer is missing.
   */
  readonly findContainer?:
    | ((labels: Readonly<Record<string, string>>) => Promise<DockerContainer | undefined>)
    | undefined;
  /**
   * Inspect lifecycle state + labels of a container by id. Returns `undefined`
   * when the container no longer exists (for example, racy removal between
   * `findContainer` and `inspectContainer`). The adapter treats `undefined` as
   * "create fresh" rather than throwing so a missing container does not block
   * persistence resumption.
   */
  readonly inspectContainer?:
    | ((id: string) => Promise<DockerContainerInfo | undefined>)
    | undefined;
  /** Start a stopped container (no-op if already running). */
  readonly startContainer?: ((id: string) => Promise<void>) | undefined;
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
}

export interface ResolvedDockerConfig {
  readonly socketPath: string;
  readonly image: string;
  readonly client: DockerClient;
}
