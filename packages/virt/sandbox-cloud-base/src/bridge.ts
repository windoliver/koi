/**
 * Cached bridge — SandboxAdapter to SandboxExecutor adapter with TTL keep-alive.
 *
 * Cloud sandbox instances are expensive to create. This bridge keeps
 * a single instance alive and reuses it across execute() calls,
 * destroying it after a configurable TTL of inactivity.
 */

import type {
  SandboxAdapter,
  SandboxError,
  SandboxExecutor,
  SandboxInstance,
  SandboxProfile,
  SandboxResult,
} from "@koi/core";

/** Configuration for the cached bridge. */
export interface BridgeConfig {
  readonly adapter: SandboxAdapter;
  readonly profile: SandboxProfile;
  /** Time-to-live in ms after last use. Default: 60_000. */
  readonly ttlMs?: number;
}

/** Default TTL: 60 seconds. */
const DEFAULT_TTL_MS = 60_000;

/** Extended executor with explicit dispose, warmup, and instance access. */
export interface CachedExecutor extends SandboxExecutor {
  readonly dispose: () => Promise<void>;
  /** Eagerly create and cache the instance. No-op if already warm. */
  readonly warmup: () => Promise<void>;
  /** Get the currently cached instance, or undefined if not yet created. */
  readonly getInstance: () => SandboxInstance | undefined;
}

/**
 * Create a cached bridge from a SandboxAdapter to SandboxExecutor.
 *
 * The bridge lazily creates a SandboxInstance on first execute(),
 * reuses it across calls, and destroys it after TTL of inactivity.
 */
export function createCachedBridge(config: BridgeConfig): CachedExecutor {
  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
  const profileTimeoutMs = config.profile.resources.timeoutMs;

  // Mutable state — instance lifecycle management
  let instance: SandboxInstance | undefined;
  // let justified: inflight tracks the pending create() to prevent duplicate instance creation
  let inflightCreate: Promise<SandboxInstance> | undefined;
  let ttlTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function resetTtl(): void {
    if (ttlTimer !== undefined) {
      clearTimeout(ttlTimer);
    }
    ttlTimer = setTimeout(() => {
      void destroyInstance();
    }, ttlMs);
  }

  async function ensureInstance(): Promise<SandboxInstance> {
    if (disposed) {
      throw new Error("CachedBridge has been disposed");
    }
    if (instance !== undefined) {
      return instance;
    }
    // Lock: reuse in-flight creation to prevent concurrent duplicate instances
    if (inflightCreate === undefined) {
      inflightCreate = config.adapter.create(config.profile).then((inst) => {
        instance = inst;
        inflightCreate = undefined;
        return inst;
      });
    }
    return inflightCreate;
  }

  async function destroyInstance(): Promise<void> {
    if (ttlTimer !== undefined) {
      clearTimeout(ttlTimer);
      ttlTimer = undefined;
    }
    if (instance !== undefined) {
      const toDestroy = instance;
      instance = undefined;
      await toDestroy.destroy();
    }
  }

  return {
    execute: async (
      code: string,
      _input: unknown,
      timeoutMs: number,
    ): Promise<
      | { readonly ok: true; readonly value: SandboxResult }
      | { readonly ok: false; readonly error: SandboxError }
    > => {
      const startTime = performance.now();

      // Clamp caller timeout to profile-defined maximum (Decision 6)
      const effectiveTimeout =
        profileTimeoutMs !== undefined ? Math.min(timeoutMs, profileTimeoutMs) : timeoutMs;

      try {
        const inst = await ensureInstance();

        // Execute code via the sandbox instance's exec method
        const result = await inst.exec("sh", ["-c", code], { timeoutMs: effectiveTimeout });

        // Reset TTL after execution completes — not before — to prevent
        // mid-flight instance destruction on long-running calls.
        resetTtl();

        const durationMs = performance.now() - startTime;

        if (result.timedOut) {
          return {
            ok: false,
            error: { code: "TIMEOUT", message: "Execution timed out", durationMs },
          };
        }

        if (result.oomKilled) {
          return {
            ok: false,
            error: { code: "OOM", message: "Out of memory", durationMs },
          };
        }

        if (result.exitCode !== 0) {
          return {
            ok: false,
            error: {
              code: "CRASH",
              message: `Process exited with code ${String(result.exitCode)}: ${result.stderr}`,
              durationMs,
            },
          };
        }

        // Parse output from stdout
        let output: unknown;
        try {
          output = JSON.parse(result.stdout);
        } catch {
          output = result.stdout;
        }

        return {
          ok: true,
          value: { output, durationMs },
        };
      } catch (e: unknown) {
        const durationMs = performance.now() - startTime;
        return {
          ok: false,
          error: {
            code: "CRASH",
            message: e instanceof Error ? e.message : String(e),
            durationMs,
          },
        };
      }
    },

    dispose: async (): Promise<void> => {
      disposed = true;
      await destroyInstance();
    },

    warmup: async (): Promise<void> => {
      await ensureInstance();
    },

    getInstance: (): SandboxInstance | undefined => instance,
  };
}
