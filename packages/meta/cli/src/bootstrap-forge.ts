/**
 * Shared forge bootstrap factory — extracted from start.ts and serve.ts
 * to eliminate duplication of sandbox bridge + forge bootstrap setup.
 */

import type { SandboxExecutor } from "@koi/core";
import type { createForgeBootstrap } from "@koi/forge";
import type { SandboxBridge } from "@koi/sandbox-ipc";
import type { Indexer, Retriever } from "@koi/search-provider";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ForgeBootstrapResult {
  /** The forge bootstrap bundle (middleware, providers, store, runtime, dispose). */
  readonly bootstrap: ReturnType<typeof createForgeBootstrap>;
  /** The sandbox bridge (for cleanup). Undefined when sandbox was unavailable. */
  readonly sandboxBridge: SandboxBridge | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Bootstraps the forge system when forge is enabled in the manifest.
 *
 * Creates a sandbox bridge + executor, then wires createForgeBootstrap.
 * Returns undefined when forge is not enabled in the manifest.
 * Logs a warning and uses a fallback executor when the sandbox is unavailable.
 */
/** Optional auto-harness outputs to inject into forge middleware. */
export interface AutoHarnessOutputs {
  readonly synthesizeHarness: (
    signal: import("@koi/core").ForgeDemandSignal,
  ) => Promise<import("@koi/core").BrickArtifact | null>;
  readonly maxSynthesesPerSession: number;
  readonly policyCacheHandle: import("@koi/middleware-policy-cache").PolicyCacheHandle;
  /** Pre-created forge store — forge bootstrap must use this same instance. */
  readonly store: import("@koi/core").ForgeStore;
}

export async function bootstrapForgeOrWarn(
  manifest: { readonly forge?: unknown },
  resolveSessionId: () => string,
  verbose?: boolean,
  autoHarness?: AutoHarnessOutputs | undefined,
  search?: { readonly retriever: Retriever; readonly indexer: Indexer } | undefined,
): Promise<ForgeBootstrapResult | undefined> {
  if (!isForgeEnabled(manifest)) return undefined;

  // Lazy imports — only loaded when forge is enabled
  const [
    { createForgeBootstrap: createBootstrap },
    { createSandboxBridge, bridgeToExecutor },
    { createSandboxCommand, restrictiveProfile },
  ] = await Promise.all([import("@koi/forge"), import("@koi/sandbox-ipc"), import("@koi/sandbox")]);

  let sandboxBridge: SandboxBridge | undefined;
  let forgeExecutor: SandboxExecutor;

  try {
    const bridge = await createSandboxBridge({
      config: {
        profile: restrictiveProfile(),
        buildCommand: createSandboxCommand,
      },
    });
    sandboxBridge = bridge;
    forgeExecutor = bridgeToExecutor(bridge);
  } catch {
    process.stderr.write("warn: sandbox unavailable, forged tool execution disabled\n");
    forgeExecutor = {
      execute: async () => ({
        ok: false as const,
        error: {
          code: "PERMISSION" as const,
          message:
            "Sandbox executor not configured — forged tool execution is not available in this CLI session",
          durationMs: 0,
        },
      }),
    };
  }

  const bootstrap = createBootstrap({
    executor: forgeExecutor,
    forgeConfig: { enabled: true },
    resolveSessionId,
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`warn: forge bootstrap failed: ${msg}\n`);
    },
    ...(autoHarness !== undefined
      ? {
          store: autoHarness.store,
          synthesizeHarness: autoHarness.synthesizeHarness,
          maxSynthesesPerSession: autoHarness.maxSynthesesPerSession,
          policyCacheHandle: autoHarness.policyCacheHandle,
        }
      : {}),
    ...(search !== undefined ? { retriever: search.retriever, indexer: search.indexer } : {}),
  });

  if (verbose) {
    process.stderr.write("Forge: enabled\n");
  }

  return { bootstrap, sandboxBridge };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safely checks if forge is enabled in the manifest's extension fields. */
function isForgeEnabled(manifest: { readonly forge?: unknown }): boolean {
  const forge = manifest.forge;
  if (forge === null || forge === undefined || typeof forge !== "object") return false;
  const obj = forge as Record<string, unknown>;
  return obj.enabled === true;
}
