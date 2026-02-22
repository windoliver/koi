/**
 * Sandbox types — OS-level process isolation contracts.
 * Types only, zero runtime code.
 *
 * Owned by @koi/sandbox (L2). These types define the sandbox
 * extension point and are not part of the @koi/core kernel.
 */

/** Trust tier determines sandbox enforcement level. */
export type SandboxTier = "sandbox" | "verified" | "promoted";

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

/** Declarative sandbox profile — platform-agnostic policy. */
export interface SandboxProfile {
  readonly tier: SandboxTier;
  readonly filesystem: FilesystemPolicy;
  readonly network: NetworkPolicy;
  readonly resources: ResourceLimits;
  readonly env?: Readonly<Record<string, string>>;
}

/** Result of a completed sandboxed execution. */
export interface SandboxResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly signal?: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly oomKilled: boolean;
}

// ---------------------------------------------------------------------------
// Adapter contract — pluggable sandbox backends
// ---------------------------------------------------------------------------

/** Options for executing a command inside a sandbox instance. */
export interface SandboxExecOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
}

/**
 * A running sandbox environment. Stateful — must be destroyed when done.
 *
 * For OS-level backends, the instance wraps per-command process isolation.
 * For cloud backends, the instance represents a live microVM or container.
 */
export interface SandboxInstance {
  readonly exec: (
    command: string,
    args: readonly string[],
    options?: SandboxExecOptions,
  ) => Promise<SandboxResult>;
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly writeFile: (path: string, content: Uint8Array) => Promise<void>;
  readonly destroy: () => Promise<void>;
}

/**
 * Backend that creates sandbox instances from a profile.
 *
 * Each backend (OS-level, E2B, Vercel, Cloudflare, Daytona, K8s)
 * implements this contract as an independent L2 package.
 */
export interface SandboxAdapter {
  readonly name: string;
  readonly create: (profile: SandboxProfile) => Promise<SandboxInstance>;
}
