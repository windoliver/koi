/**
 * Top-level manifest resolver — composes per-section resolvers.
 *
 * Runs all section resolvers in parallel, aggregates failures,
 * merges middleware, and returns a ResolvedManifest.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { aggregateErrors } from "./errors.js";
import { resolveChannels } from "./resolve-channels.js";
import { resolveEngine } from "./resolve-engine.js";
import { resolveMiddleware } from "./resolve-middleware.js";
import { resolveModel } from "./resolve-model.js";
import { resolvePermissions } from "./resolve-permissions.js";
import { resolveSearch } from "./resolve-search.js";
import { resolveSoul } from "./resolve-soul.js";
import type {
  ResolutionContext,
  ResolutionFailure,
  ResolvedManifest,
  ResolveRegistry,
} from "./types.js";

/** Manifest shape consumed by the resolver (LoadedManifest or AgentManifest + extensions). */
interface ManifestInput {
  readonly middleware?: readonly {
    readonly name: string;
    readonly options?: Record<string, unknown>;
    readonly required?: boolean | undefined;
  }[];
  readonly model: { readonly name: string; readonly options?: Record<string, unknown> };
  readonly permissions?: {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
    readonly ask?: readonly string[];
  };
  readonly soul?: unknown;
  readonly user?: unknown;
  readonly channels?: unknown;
  readonly engine?: unknown;
  readonly search?: unknown;
}

/**
 * Resolves a full manifest into runtime instances.
 *
 * Runs all per-section resolvers in parallel:
 * - Middleware (explicit entries from manifest.middleware)
 * - Soul (from manifest.soul / manifest.user)
 * - Permissions (from manifest.permissions)
 * - Model (from manifest.model)
 *
 * On success: merges middleware (explicit + soul + permissions), sorts by priority.
 * On failure: aggregates all section errors into a single KoiError.
 */
export async function resolveManifest(
  manifest: ManifestInput,
  registry: ResolveRegistry,
  context: ResolutionContext,
): Promise<Result<ResolvedManifest, KoiError>> {
  // Run all sections in parallel
  const [
    middlewareResult,
    soulResult,
    permissionsResult,
    modelResult,
    channelsResult,
    engineResult,
    searchResult,
  ] = await Promise.all([
    resolveMiddleware(manifest.middleware ?? [], registry, context),
    resolveSoul({ soul: manifest.soul, user: manifest.user }, registry, context),
    resolvePermissions(manifest.permissions, registry, context),
    resolveModel(manifest.model, registry, context),
    resolveChannels(manifest.channels, registry, context),
    resolveEngine(manifest.engine, registry, context),
    resolveSearch(manifest.search, registry, context),
  ]);

  // Collect failures
  const failures: ResolutionFailure[] = [];

  if (!middlewareResult.ok) {
    failures.push({
      section: "middleware",
      name: "middleware",
      error: middlewareResult.error,
    });
  }

  if (!soulResult.ok) {
    failures.push({
      section: "soul",
      name: "soul",
      error: soulResult.error,
    });
  }

  if (!permissionsResult.ok) {
    failures.push({
      section: "permissions",
      name: "permissions",
      error: permissionsResult.error,
    });
  }

  if (!modelResult.ok) {
    failures.push({
      section: "model",
      name: manifest.model.name,
      error: modelResult.error,
    });
  }

  if (!channelsResult.ok) {
    failures.push({
      section: "channels",
      name: "channels",
      error: channelsResult.error,
    });
  }

  if (!engineResult.ok) {
    failures.push({
      section: "engine",
      name:
        typeof manifest.engine === "string"
          ? manifest.engine
          : typeof manifest.engine === "object" &&
              manifest.engine !== null &&
              "name" in manifest.engine &&
              typeof manifest.engine.name === "string"
            ? manifest.engine.name
            : "engine",
      error: engineResult.error,
    });
  }

  if (!searchResult.ok) {
    failures.push({
      section: "search",
      name:
        typeof manifest.search === "string"
          ? manifest.search
          : typeof manifest.search === "object" &&
              manifest.search !== null &&
              "name" in manifest.search &&
              typeof manifest.search.name === "string"
            ? manifest.search.name
            : "search",
      error: searchResult.error,
    });
  }

  if (failures.length > 0) {
    return { ok: false, error: aggregateErrors(failures) };
  }

  // All results are ok at this point — extract values with narrowing
  if (
    !middlewareResult.ok ||
    !soulResult.ok ||
    !permissionsResult.ok ||
    !modelResult.ok ||
    !channelsResult.ok ||
    !engineResult.ok ||
    !searchResult.ok
  ) {
    // Unreachable — failures.length > 0 would have returned above.
    // This guard exists solely to narrow the discriminated union for TypeScript.
    return { ok: false, error: aggregateErrors(failures) };
  }

  // Extract middleware and warnings from resolution result
  const explicitMiddleware = middlewareResult.value.middleware;
  const middlewareWarnings = middlewareResult.value.warnings;

  // Merge middleware: explicit + soul + permissions (immutable)
  const optionalMiddleware: readonly KoiMiddleware[] = [
    soulResult.value,
    permissionsResult.value,
  ].filter((mw): mw is KoiMiddleware => mw !== undefined);

  const allMiddleware: readonly KoiMiddleware[] = [...explicitMiddleware, ...optionalMiddleware];

  // Sort by priority (lower = outer onion layer = runs first)
  const DEFAULT_PRIORITY = 500;
  const sorted = [...allMiddleware].sort(
    (a, b) => (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY),
  );

  // Build result — only include optional fields when present
  const resolved: ResolvedManifest = {
    middleware: sorted,
    model: modelResult.value,
    warnings: middlewareWarnings,
    ...(channelsResult.value !== undefined ? { channels: channelsResult.value } : {}),
    ...(engineResult.value !== undefined ? { engine: engineResult.value } : {}),
    ...(searchResult.value !== undefined ? { search: searchResult.value } : {}),
  };

  return { ok: true, value: resolved };
}
