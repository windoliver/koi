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
  /** Abort signal — kills the process when aborted. */
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Spawn options and handle for long-lived interactive processes
// ---------------------------------------------------------------------------

/** Options for spawning a long-lived interactive process inside a sandbox. */
export interface SandboxSpawnOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Abort signal — kills the process when aborted. */
  readonly signal?: AbortSignal;
}

/** Writable stdin pipe for a spawned sandbox process. */
export interface SandboxStdinPipe {
  readonly write: (data: string | Uint8Array) => void | Promise<void>;
  readonly end: () => void;
}

/**
 * Handle to a long-lived interactive process inside a sandbox.
 *
 * Unlike exec() which buffers output and returns after exit, spawn() returns
 * immediately with streams for bidirectional communication. This enables
 * JSON-RPC protocols (ACP, MCP) over stdin/stdout inside sandboxed environments.
 */
export interface SandboxProcessHandle {
  readonly pid: number;
  readonly stdin: SandboxStdinPipe;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** Resolves with exit code when the process exits. */
  readonly exited: Promise<number>;
  /** Kill the process. Defaults to SIGKILL if no signal specified. */
  readonly kill: (signal?: number) => void;
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
  /**
   * Spawn a long-lived interactive process with bidirectional stdin/stdout.
   *
   * Unlike exec(), the process is NOT run-to-completion — the caller owns
   * the lifecycle and must kill/await the process handle. This enables
   * JSON-RPC protocols (ACP, MCP) inside sandboxed environments.
   *
   * Optional — backends that only support run-to-completion omit this.
   * Callers must check for undefined before use.
   */
  readonly spawn?: (
    command: string,
    args: readonly string[],
    options?: SandboxSpawnOptions,
  ) => Promise<SandboxProcessHandle>;
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
