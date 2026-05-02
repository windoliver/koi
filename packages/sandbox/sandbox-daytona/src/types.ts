/**
 * Daytona adapter types.
 *
 * Depends only on `@koi/core`. Callers inject a `DaytonaClient` that wraps
 * the real `@daytonaio/sdk` (or any compatible API).
 */

export interface DaytonaRunOpts {
  readonly cwd?: string;
  readonly envs?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly onStdout?: (data: string) => void;
  readonly onStderr?: (data: string) => void;
  /** Abort signal forwarded to the SDK. */
  readonly signal?: AbortSignal;
  /** Forwarded only when `commands.supportsStdin === true`; otherwise rejected. */
  readonly stdin?: string;
  /** Forwarded only when `commands.supportsMaxOutputBytes === true`; otherwise rejected. */
  readonly maxOutputBytes?: number;
}

export interface DaytonaRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated?: boolean;
}

/** Minimal SDK shape — what the adapter needs from a Daytona workspace handle. */
export interface DaytonaSdkSandbox {
  readonly commands: {
    readonly run: (cmd: string, opts?: DaytonaRunOpts) => Promise<DaytonaRunResult>;
    readonly supportsStdin?: boolean;
    readonly supportsMaxOutputBytes?: boolean;
    /**
     * `true` when the SDK kills the remote command on `AbortSignal.abort()`
     * and the returned promise only resolves after termination. Without this
     * flag, calls that supply a signal are rejected fail-closed.
     */
    readonly supportsAbort?: boolean;
  };
  readonly files: {
    readonly read: (path: string) => Promise<string>;
    readonly write: (path: string, content: string) => Promise<void>;
    /** Optional binary-safe read; preferred over `read` when present. */
    readonly readBytes?: (path: string) => Promise<Uint8Array>;
    /** Optional binary-safe write; preferred over `write` when present. */
    readonly writeBytes?: (path: string, content: Uint8Array) => Promise<void>;
  };
  /**
   * Detach from / disconnect the workspace handle. In several Daytona SDK
   * versions this is a client-side close that leaves the remote workspace
   * **running**, so it cannot stand in for `destroy()` and the adapter
   * never falls back to it for teardown.
   */
  readonly close: () => Promise<void>;
  /**
   * Permanently delete the remote workspace. **Required** — the adapter's
   * `destroy()` calls only this method, never `close()`, because some SDK
   * versions implement `close` as a client-side detach that leaks billable
   * workspaces. Wrappers that cannot provide a true workspace-deletion
   * primitive cannot be used with this adapter.
   */
  readonly delete: () => Promise<void>;
}

export interface DaytonaCreateOpts {
  readonly apiKey: string;
  readonly apiUrl?: string;
  readonly target?: string;
}

export interface DaytonaClient {
  readonly createSandbox: (opts: DaytonaCreateOpts) => Promise<DaytonaSdkSandbox>;
}

export interface DaytonaAdapterConfig {
  /** API key. Falls back to `DAYTONA_API_KEY`. */
  readonly apiKey?: string;
  /** API base URL. Falls back to `DAYTONA_API_URL`. */
  readonly apiUrl?: string;
  /** Region target. Defaults to "us". */
  readonly target?: string;
  /** Injected SDK client. */
  readonly client: DaytonaClient;
}

export interface ResolvedDaytonaConfig {
  readonly apiKey: string;
  readonly apiUrl?: string;
  readonly target: string;
  readonly client: DaytonaClient;
}
