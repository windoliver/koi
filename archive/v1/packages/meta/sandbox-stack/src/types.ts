/**
 * Core types for the @koi/sandbox-stack L3 bundle.
 */

import type { SandboxAdapter, SandboxExecutor, SandboxInstance } from "@koi/core";

/** Configuration for createSandboxStack(). */
export interface SandboxStackConfig {
  /** Pre-created sandbox adapter. Injected — the stack doesn't select backends. */
  readonly adapter: SandboxAdapter;

  /**
   * Resource and timeout limits.
   *
   * Latency characteristics vary by backend:
   * - OS/IPC: per-call spawn, ~10-50ms overhead
   * - Docker/Cloud: cached instances, ~500ms-10s cold start, warm calls fast
   * - WASM: ~50-200ms first load, <1ms warm, in-process
   */
  readonly resources?: {
    /** Maximum execution timeout in ms. Default: 30_000. */
    readonly timeoutMs?: number;
    /** Maximum memory in MB. Informational — passed to profile. */
    readonly maxMemoryMb?: number;
    /** Maximum output bytes. Default: 10 MB. */
    readonly maxOutputBytes?: number;
  };

  /** Network policy. */
  readonly network?: {
    /** Whether network access is allowed. Default: false. */
    readonly allow?: boolean;
    /** Allowed hosts when network is enabled. */
    readonly allowedHosts?: readonly string[];
  };

  /**
   * Idle TTL before cached instance is destroyed, in ms.
   * Default: 60_000 (1 minute).
   */
  readonly idleTtlMs?: number;

  /**
   * Persistence scope key. When set, the bridge uses findOrCreate instead of
   * create and detaches instead of destroying on dispose — enabling cross-session
   * sandbox reuse.
   */
  readonly scope?: string | undefined;

  /**
   * Hard upper bound on sandbox lifetime in ms.
   * The sandbox is force-destroyed (not detached) after this, regardless of activity.
   */
  readonly maxLifetimeMs?: number | undefined;
}

/** Return type of createSandboxStack(). */
export interface SandboxStack {
  /** Timeout-guarded SandboxExecutor. Always available. */
  readonly executor: SandboxExecutor;

  /**
   * SandboxInstance for direct file I/O and multi-command sessions.
   * Present for process-backed adapters after warmup/first execute,
   * undefined before warmup or for WASM-like adapters that never create one.
   */
  readonly instance: SandboxInstance | undefined;

  /** Eagerly provision the sandbox instance. No-op if already warm. */
  readonly warmup: () => Promise<void>;

  /** Release all resources. Safe to call multiple times. */
  readonly dispose: () => Promise<void>;
}
