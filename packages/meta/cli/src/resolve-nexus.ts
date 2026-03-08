/**
 * Nexus stack resolution for CLI commands.
 *
 * Resolves Nexus connection from (in priority order):
 * 1. --nexus-url CLI flag
 * 2. NEXUS_URL environment variable
 * 3. manifest.nexus.url in koi.yaml
 * 4. No URL → embed mode (auto-start local Nexus)
 *
 * Auth is resolved from NEXUS_API_KEY env var (remote mode only).
 */

import type { ComponentProvider, KoiMiddleware } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NexusResolution {
  readonly middlewares: readonly KoiMiddleware[];
  readonly providers: readonly ComponentProvider[];
  readonly dispose: () => Promise<void>;
  readonly baseUrl: string;
}

interface NexusResolveInput {
  readonly nexusUrl: string | undefined;
  readonly manifestNexusUrl: string | undefined;
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolves and creates the Nexus stack if Nexus is configured or embed mode
 * should auto-start. Returns undefined if Nexus is explicitly disabled.
 */
export async function resolveNexusStack(
  input: NexusResolveInput,
): Promise<NexusResolution | undefined> {
  // Priority: CLI flag > env var > manifest config > embed mode (no URL)
  const baseUrl = input.nexusUrl ?? process.env.NEXUS_URL ?? input.manifestNexusUrl;

  const apiKey = process.env.NEXUS_API_KEY;

  // Lazy-import to avoid loading Nexus deps unless needed
  const { createNexusStack } = await import("@koi/nexus");

  const bundle = await createNexusStack({
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
  });

  return {
    middlewares: bundle.middlewares,
    providers: bundle.providers,
    dispose: bundle.dispose,
    baseUrl: bundle.config.baseUrl,
  };
}
