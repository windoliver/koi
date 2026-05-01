/**
 * E2B adapter types.
 *
 * The package depends only on `@koi/core`. Callers inject a thin `E2bClient`
 * implementation that wraps the real `@e2b/sdk` (or any compatible API).
 */

/** Per-call command execution options exposed by the SDK. */
export interface E2bRunOpts {
  readonly cwd?: string;
  readonly envs?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly onStdout?: (data: string) => void;
  readonly onStderr?: (data: string) => void;
  /**
   * Abort signal forwarded to the SDK. Callers that wrap `@e2b/sdk` should
   * map this to whatever the SDK exposes (e.g., killing the remote process).
   */
  readonly signal?: AbortSignal;
}

/** Result of a completed SDK command. */
export interface E2bRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Minimal SDK shape — what the adapter needs from `@e2b/sdk`. */
export interface E2bSdkSandbox {
  readonly commands: {
    readonly run: (cmd: string, opts?: E2bRunOpts) => Promise<E2bRunResult>;
  };
  readonly files: {
    readonly read: (path: string) => Promise<string>;
    readonly write: (path: string, content: string) => Promise<void>;
    /**
     * Optional binary-safe read. When the SDK wrapper exposes this, the
     * adapter prefers it over `read` so non-UTF-8 payloads survive intact.
     */
    readonly readBytes?: (path: string) => Promise<Uint8Array>;
    /**
     * Optional binary-safe write. When the SDK wrapper exposes this, the
     * adapter prefers it; otherwise non-UTF-8 input is rejected fail-closed.
     */
    readonly writeBytes?: (path: string, content: Uint8Array) => Promise<void>;
  };
  readonly kill: () => Promise<void>;
}

/** SDK creation options surfaced to the injected client. */
export interface E2bCreateOpts {
  readonly apiKey: string;
  readonly template?: string;
}

/** Injectable client. Production wraps `@e2b/sdk`; tests use a fake. */
export interface E2bClient {
  readonly createSandbox: (opts: E2bCreateOpts) => Promise<E2bSdkSandbox>;
}

/** Public adapter configuration. */
export interface E2bAdapterConfig {
  /** API key. Falls back to `E2B_API_KEY` from the environment. */
  readonly apiKey?: string;
  /** Custom sandbox template ID. */
  readonly template?: string;
  /** Injected SDK client. Required — keeps tests deterministic and zero-dep. */
  readonly client: E2bClient;
}

/** Validated, fully-resolved adapter configuration (internal). */
export interface ResolvedE2bConfig {
  readonly apiKey: string;
  readonly template?: string;
  readonly client: E2bClient;
}
