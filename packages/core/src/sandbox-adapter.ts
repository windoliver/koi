/**
 * Sandbox adapter contract — pluggable sandbox backends for isolated execution.
 *
 * Defines the extension point for sandbox providers (OS-level, cloud, WASM).
 * Each backend implements SandboxAdapter to create SandboxInstance environments.
 *
 * Note: These types describe OS/container-level process execution (exitCode, stdout, stderr).
 * The SandboxResult in sandbox-executor.ts describes code-level return values (output, durationMs).
 */

import type { SandboxProfile } from "./sandbox-profile.js";

// ---------------------------------------------------------------------------
// Execution options for commands inside a sandbox
// ---------------------------------------------------------------------------

/** Options for executing a command inside a sandbox instance. */
export interface SandboxExecOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  /** Streaming callback for stdout chunks. */
  readonly onStdout?: (chunk: string) => void;
  /** Streaming callback for stderr chunks. */
  readonly onStderr?: (chunk: string) => void;
  /** Maximum bytes to capture for stdout+stderr. Default: 10 MB. */
  readonly maxOutputBytes?: number;
}

// ---------------------------------------------------------------------------
// Result of a completed sandboxed process execution
// ---------------------------------------------------------------------------

/** Result of a completed sandboxed execution (process-level). */
export interface SandboxAdapterResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly signal?: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly oomKilled: boolean;
  /** Whether stdout or stderr was truncated due to maxOutputBytes. */
  readonly truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Sandbox instance — a running sandbox environment
// ---------------------------------------------------------------------------

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
  ) => Promise<SandboxAdapterResult>;
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly writeFile: (path: string, content: Uint8Array) => Promise<void>;
  readonly destroy: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Sandbox adapter — factory for sandbox instances
// ---------------------------------------------------------------------------

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
