import type { CapabilityRequirements } from "./adapter-capabilities.js";

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
  readonly defaultReadAccess: "open" | "closed";
  readonly allowRead?: readonly string[];
  readonly denyRead?: readonly string[];
  readonly allowWrite?: readonly string[];
  readonly denyWrite?: readonly string[];
}

/** Network isolation policy. */
export interface NetworkPolicy {
  readonly allow: boolean;
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

/**
 * Generic SSH connection target. Consumed only by `@koi/sandbox-ssh`.
 * Other adapters MUST ignore this field.
 *
 * Kept as a generic L0 struct so no SSH library types leak into the kernel.
 * Auth is key-based only — no password fields exist here by design.
 */
export interface SandboxSshTarget {
  readonly host: string;
  readonly user: string;
  /** Absolute path to a private key file readable by the calling process. */
  readonly keyPath: string;
  /** TCP port. Defaults to 22 when omitted. */
  readonly port?: number;
}

/** Declarative sandbox profile — platform-agnostic policy. */
export interface SandboxProfile {
  readonly filesystem: FilesystemPolicy;
  readonly network: NetworkPolicy;
  readonly resources: ResourceLimits;
  readonly env?: Readonly<Record<string, string>>;
  readonly nexusMounts?: readonly NexusFuseMount[];
  /**
   * Capabilities the chosen backend MUST satisfy. Read by `@koi/sandbox-router`
   * to filter the adapter set. Profiles that omit this field accept any adapter.
   */
  readonly required?: CapabilityRequirements;
  /** SSH target for the SSH backend. Ignored by all other adapters. */
  readonly ssh?: SandboxSshTarget;
}
