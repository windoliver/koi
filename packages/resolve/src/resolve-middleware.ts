/**
 * Middleware section resolver.
 *
 * Resolves all middleware entries from the manifest in parallel,
 * validates no duplicate names, and returns sorted middleware.
 */

import type { KoiError, KoiMiddleware, MiddlewareConfig, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import { aggregateErrors } from "./errors.js";
import { resolveOne } from "./resolve-one.js";
import type { ResolutionContext, ResolutionFailure, ResolveRegistry } from "./types.js";

/**
 * Resolves all middleware entries from the manifest.
 *
 * - Checks for duplicate names
 * - Resolves all in parallel via Promise.allSettled
 * - Aggregates all failures
 * - Returns sorted by priority (lower = outer onion layer = runs first)
 */
export async function resolveMiddleware(
  configs: readonly MiddlewareConfig[],
  registry: ResolveRegistry,
  context: ResolutionContext,
): Promise<Result<readonly KoiMiddleware[], KoiError>> {
  if (configs.length === 0) {
    return { ok: true, value: [] };
  }

  // Check for duplicate names
  const names = configs.map((c) => c.name);
  const duplicateName = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicateName !== undefined) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Duplicate middleware name "${duplicateName}" in manifest`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  // Resolve all in parallel
  const results = await Promise.allSettled(
    configs.map((config) => resolveOne<KoiMiddleware>("middleware", config, registry, context)),
  );

  // Partition results into successes and failures (immutable)
  const { middleware, failures } = results.reduce<{
    readonly middleware: readonly KoiMiddleware[];
    readonly failures: readonly ResolutionFailure[];
  }>(
    (acc, result, i) => {
      const config = configs[i];
      if (config === undefined) return acc;

      if (result.status === "rejected") {
        return {
          middleware: acc.middleware,
          failures: [
            ...acc.failures,
            {
              section: "middleware" as const,
              index: i,
              name: config.name,
              error: {
                code: "INTERNAL" as const,
                message:
                  result.reason instanceof Error ? result.reason.message : String(result.reason),
                retryable: RETRYABLE_DEFAULTS.INTERNAL,
                cause: result.reason,
              },
            },
          ],
        };
      }
      if (!result.value.ok) {
        return {
          middleware: acc.middleware,
          failures: [
            ...acc.failures,
            {
              section: "middleware" as const,
              index: i,
              name: config.name,
              error: result.value.error,
            },
          ],
        };
      }
      return {
        middleware: [...acc.middleware, result.value.value],
        failures: acc.failures,
      };
    },
    { middleware: [], failures: [] },
  );

  if (failures.length > 0) {
    return { ok: false, error: aggregateErrors(failures) };
  }

  // Sort by priority (default 500, lower = runs first)
  const DEFAULT_PRIORITY = 500;
  const sorted = [...middleware].sort(
    (a, b) => (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY),
  );

  return { ok: true, value: sorted };
}
