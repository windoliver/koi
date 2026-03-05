/**
 * Sandbox profile contract — platform-agnostic isolation policy.
 *
 * Defines what a sandboxed process is allowed to do: filesystem access,
 * network access, and resource limits. Used by @koi/sandbox (OS-level)
 * and @koi/sandbox-ipc (IPC bridge) to configure execution environments.
 *
 * Platform-specific implementations (seatbelt, bwrap, Docker) translate
 * this profile into their native configuration format.
 */

/** Filesystem isolation policy. */
export interface FilesystemPolicy {
  readonly allowRead?: readonly string[];
  readonly denyRead?: readonly string[];
  readonly allowWrite?: readonly string[];
  readonly denyWrite?: readonly string[];
}

/** Network isolation policy. */
export interface NetworkPolicy {
  readonly allow: boolean;
  readonly allowedHosts?: readonly string[];
}

/** OS-level resource limits for sandboxed processes. */
export interface ResourceLimits {
  readonly maxMemoryMb?: number;
  readonly timeoutMs?: number;
  readonly maxPids?: number;
  readonly maxOpenFiles?: number;
}

/** Nexus FUSE mount — mounts Nexus virtual filesystem inside a sandbox. */
export interface NexusFuseMount {
  readonly nexusUrl: string;
  readonly apiKey: string;
  readonly mountPath: string;
  readonly agentId?: string;
}

/** Declarative sandbox profile — platform-agnostic policy. */
export interface SandboxProfile {
  readonly filesystem: FilesystemPolicy;
  readonly network: NetworkPolicy;
  readonly resources: ResourceLimits;
  readonly env?: Readonly<Record<string, string>>;
  readonly nexusMounts?: readonly NexusFuseMount[];
}
