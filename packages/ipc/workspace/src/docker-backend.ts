/**
 * Docker container backend for workspace isolation.
 *
 * Creates isolated container workspaces per agent via a SandboxAdapter,
 * with marker files for lifecycle tracking. No Docker SDK dependency —
 * uses the L0 SandboxAdapter contract via dependency injection.
 */

import type {
  AgentId,
  FilesystemPolicy,
  KoiError,
  ResolvedWorkspaceConfig,
  Result,
  SandboxAdapter,
  SandboxInstance,
  SandboxProfile,
  WorkspaceBackend,
  WorkspaceId,
  WorkspaceInfo,
} from "@koi/core";
import { RETRYABLE_DEFAULTS, workspaceId } from "@koi/core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Host filesystem mount mode for the container workspace. */
export type MountMode = "none" | "ro" | "rw";

/**
 * Container reuse scope across agents.
 * - "session": fresh ephemeral container per create(), destroyed on dispose (strongest isolation)
 * - "per-agent": one container per agentId (default)
 * - "shared": reuse a single container across all agents with unique sub-paths
 */
export type ContainerScope = "session" | "per-agent" | "shared";

/** Configuration for the Docker container workspace backend. */
export interface DockerWorkspaceBackendConfig {
  /** Sandbox adapter that creates container instances. Injected from L2. */
  readonly adapter: SandboxAdapter;
  /** Override default sandbox profile settings (shallow merge). */
  readonly profileOverrides?: Partial<SandboxProfile>;
  /** Working directory inside the container. Default: "/workspace". */
  readonly workDir?: string;
  /**
   * Filesystem mount mode. Default: "none" (most restrictive).
   * - "none": isolated sandbox, no host mount
   * - "ro": read-only workspace
   * - "rw": full read-write
   *
   * `profileOverrides.filesystem` takes precedence over `mountMode` if both provided.
   */
  readonly mountMode?: MountMode;
  /**
   * Container reuse scope. Default: "per-agent".
   * - "session": fresh ephemeral container per create(), destroyed on dispose (strongest isolation)
   * - "per-agent": one container per agentId (current default)
   * - "shared": reuse a single container across all agents with unique sub-paths
   */
  readonly scope?: ContainerScope;
}

const DEFAULT_WORK_DIR = "/workspace";
const MARKER_FILENAME = ".koi-workspace";

/**
 * Path segments that must never appear in agent IDs used for shared-scope sub-paths.
 * Prevents agents from targeting credential directories or sensitive files.
 * Mirrors NanoClaw's blocked patterns.
 */
const BLOCKED_PATH_SEGMENTS: readonly string[] = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".gcloud",
  ".kube",
  ".docker",
  ".env",
  ".netrc",
  ".npmrc",
  ".secret",
  "credentials",
  "id_rsa",
  "id_ed25519",
  "private_key",
] as const;

/** Derive FilesystemPolicy from a MountMode and workDir. */
export function createFilesystemPolicy(mode: MountMode, workDir: string): FilesystemPolicy {
  switch (mode) {
    case "none":
      return { allowRead: [], allowWrite: [] };
    case "ro":
      return { allowRead: [workDir], allowWrite: [] };
    case "rw":
      return { allowRead: [workDir], allowWrite: [workDir] };
  }
}

const DEFAULT_PROFILE: SandboxProfile = {
  filesystem: {
    allowRead: [],
    allowWrite: [],
  },
  network: { allow: false },
  resources: { maxMemoryMb: 512 },
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Docker container WorkspaceBackend.
 *
 * Validates that the adapter is provided. Returns Result.error on
 * validation failure. The returned backend creates one container per
 * agent via the injected SandboxAdapter (or reuses a shared container
 * when `scope: "shared"`).
 */
export function createDockerWorkspaceBackend(
  config: DockerWorkspaceBackendConfig,
): Result<WorkspaceBackend, KoiError> {
  if (!config.adapter) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "DockerWorkspaceBackendConfig.adapter is required",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const { adapter } = config;
  const workDir = config.workDir ?? DEFAULT_WORK_DIR;
  const scope = config.scope ?? "per-agent";

  // Resolve profile: profileOverrides.filesystem takes precedence over mountMode
  const mountMode = config.mountMode ?? "none";
  const baseProfile: SandboxProfile = {
    ...DEFAULT_PROFILE,
    filesystem: createFilesystemPolicy(mountMode, workDir),
  };
  const profile: SandboxProfile = config.profileOverrides
    ? { ...baseProfile, ...config.profileOverrides }
    : baseProfile;

  /** Tracked entry: instance + the workspace directory for isHealthy probes. */
  interface TrackedEntry {
    readonly instance: SandboxInstance;
    readonly workDir: string;
  }

  // Mutable Map justified: internal tracking state encapsulated in closure,
  // not exposed to callers. Maps workspace ID → TrackedEntry for dispose/isHealthy.
  const tracked = new Map<string, TrackedEntry>();

  // Shared scope state: mutable ref count + instance, encapsulated in closure.
  // let justified: shared instance is re-assigned on first create and last dispose.
  let sharedState: { readonly instance: SandboxInstance; refCount: number } | undefined;
  // let justified: serializes concurrent shared-scope creates to prevent double-create.
  let pendingCreate: Promise<SandboxInstance> | undefined;

  // TS control-flow narrows closure variables after early returns, but `await`
  // can cause them to be modified by another microtask. This accessor prevents
  // the narrowing so post-await reads see the actual runtime value.
  function getSharedState(): typeof sharedState {
    return sharedState;
  }

  function resolveSharedWorkDir(agentId: AgentId): Result<string, KoiError> {
    const idStr = String(agentId);
    const agentWorkDir = `${workDir}/${idStr}`;

    // Defense-in-depth: reject paths that could escape the workDir container root
    if (idStr.includes("..") || !agentWorkDir.startsWith(`${workDir}/`)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Agent ID "${idStr}" would escape workDir boundary`,
          retryable: false,
        },
      };
    }

    // Reject agent IDs targeting credential/sensitive directories
    const idLower = idStr.toLowerCase();
    const blocked = BLOCKED_PATH_SEGMENTS.find((seg) => idLower.includes(seg));
    if (blocked !== undefined) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `Agent ID "${idStr}" contains blocked path segment "${blocked}"`,
          retryable: false,
        },
      };
    }

    return { ok: true, value: agentWorkDir };
  }

  async function acquireInstance(
    agentId: AgentId,
  ): Promise<
    Result<{ readonly instance: SandboxInstance; readonly agentWorkDir: string }, KoiError>
  > {
    if (scope === "shared") {
      const resolved = resolveSharedWorkDir(agentId);
      if (!resolved.ok) return resolved;
      const agentWorkDir = resolved.value;

      if (sharedState) {
        sharedState.refCount += 1;
        return { ok: true, value: { instance: sharedState.instance, agentWorkDir } };
      }

      // Serialize: if another create is in-flight, wait for it
      if (pendingCreate) {
        try {
          await pendingCreate;
        } catch (_e: unknown) {
          // First caller handles the error; check sharedState below
        }
        // Re-read via accessor: TS narrowing can't track async mutations
        const current = getSharedState();
        if (current) {
          current.refCount += 1;
          return { ok: true, value: { instance: current.instance, agentWorkDir } };
        }
      }

      try {
        const createPromise = adapter.create(profile);
        pendingCreate = createPromise;
        const instance = await createPromise;
        pendingCreate = undefined;
        sharedState = { instance, refCount: 1 };
        return { ok: true, value: { instance, agentWorkDir } };
      } catch (e: unknown) {
        pendingCreate = undefined;
        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: `Failed to create shared container: ${e instanceof Error ? e.message : String(e)}`,
            retryable: true,
            cause: e,
          },
        };
      }
    }

    // session / per-agent: each call creates a new container
    try {
      const instance = await adapter.create(profile);
      return { ok: true, value: { instance, agentWorkDir: workDir } };
    } catch (e: unknown) {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: `Failed to create container for agent ${agentId}: ${e instanceof Error ? e.message : String(e)}`,
          retryable: true,
          cause: e,
        },
      };
    }
  }

  const backend: WorkspaceBackend = {
    name: "docker",
    isSandboxed: true,

    create: async (
      agentId: AgentId,
      _config: ResolvedWorkspaceConfig,
    ): Promise<Result<WorkspaceInfo, KoiError>> => {
      const createdAt = Date.now();
      const id = workspaceId(`docker-${agentId}-${createdAt}`);

      const acquired = await acquireInstance(agentId);
      if (!acquired.ok) return acquired;
      const { instance, agentWorkDir } = acquired.value;

      // Write marker file inside container for lifecycle tracking
      const marker = JSON.stringify({ id, agentId, createdAt, workDir: agentWorkDir });
      try {
        await instance.writeFile(
          `${agentWorkDir}/${MARKER_FILENAME}`,
          new TextEncoder().encode(marker),
        );
      } catch (e: unknown) {
        // Cleanup container on marker write failure (destroy if session or per-agent)
        if (scope === "session" || scope === "per-agent") {
          try {
            await instance.destroy();
          } catch (destroyErr: unknown) {
            console.warn(
              `[workspace] Best-effort container cleanup failed for agent ${agentId}:`,
              destroyErr instanceof Error ? destroyErr.message : String(destroyErr),
            );
          }
        } else if (sharedState) {
          sharedState.refCount -= 1;
          if (sharedState.refCount <= 0) {
            try {
              await sharedState.instance.destroy();
            } catch (destroyErr: unknown) {
              console.warn(
                `[workspace] Best-effort shared container cleanup failed for agent ${agentId}:`,
                destroyErr instanceof Error ? destroyErr.message : String(destroyErr),
              );
            }
            sharedState = undefined;
          }
        }
        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: `Failed to write marker file in container for agent ${agentId}: ${e instanceof Error ? e.message : String(e)}`,
            retryable: true,
            cause: e,
          },
        };
      }

      tracked.set(id, { instance, workDir: agentWorkDir });

      return {
        ok: true,
        value: {
          id,
          path: agentWorkDir,
          createdAt,
          metadata: {
            adapterName: adapter.name,
            workDir: agentWorkDir,
          },
        },
      };
    },

    dispose: async (wsId: WorkspaceId): Promise<Result<void, KoiError>> => {
      const entry = tracked.get(wsId);
      if (!entry) {
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: `Unknown workspace ID: ${wsId}`,
            retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
          },
        };
      }

      // Delete before destroy (mirrors git backend pattern — prevents
      // double-dispose if destroy throws and caller retries)
      tracked.delete(wsId);

      if (scope === "shared" && sharedState) {
        sharedState.refCount -= 1;
        if (sharedState.refCount > 0) {
          return { ok: true, value: undefined };
        }
        // Last ref — destroy the shared container
        const inst = sharedState.instance;
        sharedState = undefined;
        try {
          await inst.destroy();
        } catch (e: unknown) {
          return {
            ok: false,
            error: {
              code: "EXTERNAL",
              message: `Failed to destroy shared container ${wsId}: ${e instanceof Error ? e.message : String(e)}`,
              retryable: false,
              cause: e,
            },
          };
        }
        return { ok: true, value: undefined };
      }

      try {
        await entry.instance.destroy();
      } catch (e: unknown) {
        return {
          ok: false,
          error: {
            code: "EXTERNAL",
            message: `Failed to destroy container ${wsId}: ${e instanceof Error ? e.message : String(e)}`,
            retryable: false,
            cause: e,
          },
        };
      }

      return { ok: true, value: undefined };
    },

    isHealthy: async (wsId: WorkspaceId): Promise<boolean> => {
      const entry = tracked.get(wsId);
      if (!entry) return false;

      try {
        const result = await entry.instance.exec("test", ["-d", entry.workDir]);
        return result.exitCode === 0;
      } catch (_e: unknown) {
        // Probe semantics: any failure → unhealthy
        return false;
      }
    },
  };

  return { ok: true, value: backend };
}
