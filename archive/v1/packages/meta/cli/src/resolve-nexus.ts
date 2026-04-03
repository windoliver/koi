/**
 * Nexus stack resolution for CLI commands.
 *
 * Resolves Nexus connection from (in priority order):
 * 1. --nexus-url CLI flag
 * 2. NEXUS_URL environment variable
 * 3. manifest.nexus.url from koi.yaml
 * 4. No URL → embed mode (auto-start local Nexus)
 *
 * Auth is resolved from NEXUS_API_KEY env var (remote mode only).
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ComponentProvider, KoiMiddleware } from "@koi/core";
import type { Indexer, Retriever } from "@koi/search-provider";
import type { StackContribution } from "./contribution-graph.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NexusResolution {
  readonly middlewares: readonly KoiMiddleware[];
  readonly providers: readonly ComponentProvider[];
  readonly dispose: () => Promise<void>;
  readonly baseUrl: string;
  readonly search?: { readonly retriever: Retriever; readonly indexer: Indexer } | undefined;
}

// ---------------------------------------------------------------------------
// Build helper
// ---------------------------------------------------------------------------

/**
 * Runs `uv sync` in the Nexus source directory when both `--nexus-build`
 * and `--nexus-source` are set.
 *
 * When `--nexus-build` is used without `--nexus-source`, the flag is still
 * forwarded to Docker Compose via `startNexusStack()` — no `uv sync` needed.
 *
 * Call this before Nexus startup in `up`, `start`, and `serve`.
 */
export function runNexusBuildIfNeeded(nexusBuild: boolean, nexusSource: string | undefined): void {
  if (!nexusBuild || nexusSource === undefined) return;

  // Expand tilde — spawnSync doesn't run through a shell
  const resolved = nexusSource.startsWith("~/")
    ? join(homedir(), nexusSource.slice(2))
    : nexusSource;

  process.stderr.write(`Running uv sync in ${resolved}...\n`);
  const result = spawnSync("uv", ["sync"], {
    cwd: resolved,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.stderr.write(`error: uv sync failed with exit code ${String(result.status ?? 1)}\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolves and creates the Nexus stack. Falls back to embed mode (auto-start
 * local Nexus) when no URL is configured.
 *
 * When `embedProfile` is provided, it controls the Nexus deploy profile
 * (e.g. "lite", "full") for embed mode. Ignored when a URL is provided.
 */
export async function resolveNexusStack(
  nexusUrl: string | undefined,
  manifestNexusUrl: string | undefined,
  embedProfile?: string | undefined,
  nexusSource?: string | undefined,
): Promise<NexusResolution> {
  // Priority: CLI flag > env var > manifest nexus.url > embed mode (no URL)
  const baseUrl = nexusUrl ?? process.env.NEXUS_URL ?? manifestNexusUrl;

  const apiKey = process.env.NEXUS_API_KEY;

  // Lazy-import to avoid loading Nexus deps unless needed
  const { createNexusStack } = await import("@koi/nexus");

  const bundle = await createNexusStack({
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(embedProfile !== undefined ? { embedProfile } : {}),
    ...(nexusSource !== undefined ? { sourceDir: nexusSource } : {}),
  });

  return {
    middlewares: bundle.middlewares,
    providers: bundle.providers,
    dispose: bundle.dispose,
    baseUrl: bundle.config.baseUrl,
    search:
      bundle.backends.search !== undefined
        ? { retriever: bundle.backends.search.retriever, indexer: bundle.backends.search.indexer }
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Safe wrapper — resolves Nexus or returns empty defaults
// ---------------------------------------------------------------------------

/** Empty Nexus resolution used when Nexus is unavailable. */
const EMPTY_NEXUS = {
  middlewares: [],
  providers: [],
  dispose: undefined,
  baseUrl: undefined,
  search: undefined,
} as const satisfies NexusResolvedState;

/** Resolved Nexus state with optional values for the dispose/baseUrl. */
export interface NexusResolvedState {
  readonly middlewares: readonly KoiMiddleware[];
  readonly providers: readonly ComponentProvider[];
  readonly dispose: (() => Promise<void>) | undefined;
  readonly baseUrl: string | undefined;
  readonly search?: { readonly retriever: Retriever; readonly indexer: Indexer } | undefined;
}

/** Resolution result bundling state and contribution metadata. */
export interface NexusResolutionWithContribution {
  readonly state: NexusResolvedState;
  readonly contribution: StackContribution;
}

/**
 * Resolves Nexus stack with graceful fallback.
 *
 * Returns empty defaults if Nexus initialization fails, logging a warning
 * to stderr. The agent can still run with local backends.
 */
export async function resolveNexusOrWarn(
  nexusUrl: string | undefined,
  manifestNexusUrl: string | undefined,
  verbose: boolean,
  embedProfile?: string | undefined,
  nexusSource?: string | undefined,
): Promise<NexusResolutionWithContribution> {
  // Priority: CLI flag > env var > manifest nexus.url
  const configuredUrl = nexusUrl ?? process.env.NEXUS_URL ?? manifestNexusUrl;

  // No URL configured and no embed mode → skip
  if (configuredUrl === undefined && embedProfile === undefined) {
    return {
      state: EMPTY_NEXUS,
      contribution: {
        id: "nexus",
        label: "Nexus",
        enabled: false,
        source: "runtime",
        status: "skipped",
        reason: "No Nexus URL configured",
        packages: [],
      },
    };
  }

  try {
    const nexus = await resolveNexusStack(nexusUrl, manifestNexusUrl, embedProfile, nexusSource);
    if (verbose) {
      process.stderr.write(`Nexus: ${nexus.baseUrl}\n`);
    }

    const packages: StackContribution["packages"][number][] = [];
    if (nexus.middlewares.length > 0) {
      packages.push({
        id: "@koi/nexus",
        kind: "middleware",
        source: "static",
        middlewareNames: nexus.middlewares.map((m) => m.name),
      });
    }
    if (nexus.providers.length > 0) {
      packages.push({
        id: "@koi/nexus",
        kind: "provider",
        source: "static",
        providerNames: nexus.providers.map((p) => p.name),
      });
    }
    // Nexus sub-packages
    packages.push({
      id: "@koi/nexus-client",
      kind: "subsystem",
      source: "static",
      notes: [`baseUrl: ${nexus.baseUrl}`],
    });
    if (nexus.search !== undefined) {
      packages.push({
        id: "@koi/nexus-search",
        kind: "subsystem",
        source: "static",
        notes: ["retriever + indexer"],
      });
    }

    return {
      state: nexus,
      contribution: {
        id: "nexus",
        label: "Nexus",
        enabled: true,
        source: "runtime",
        status: "active",
        packages,
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`warn: Nexus initialization failed: ${message}\n`);
    return {
      state: EMPTY_NEXUS,
      contribution: {
        id: "nexus",
        label: "Nexus",
        enabled: false,
        source: "runtime",
        status: "failed",
        reason: message,
        packages: [
          { id: "@koi/nexus", kind: "subsystem", source: "static", notes: ["not available"] },
        ],
      },
    };
  }
}
