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
import type {
  MiddlewareResolutionResult,
  ResolutionContext,
  ResolutionFailure,
  ResolveRegistry,
} from "./types.js";

/**
 * Resolves all middleware entries from the manifest.
 *
 * - Checks for duplicate names
 * - Resolves all in parallel via Promise.allSettled
 * - Optional middleware (required === false) degrade gracefully with warnings
 * - Required middleware failures abort resolution
 * - Returns sorted by priority (lower = outer onion layer = runs first)
 */
export async function resolveMiddleware(
  configs: readonly MiddlewareConfig[],
  registry: ResolveRegistry,
  context: ResolutionContext,
): Promise<Result<MiddlewareResolutionResult, KoiError>> {
  if (configs.length === 0) {
    return { ok: true, value: { middleware: [], warnings: [] } };
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

  // Partition results into 3 buckets (immutable)
  const { middleware, requiredFailures, optionalWarnings } = results.reduce<{
    readonly middleware: readonly KoiMiddleware[];
    readonly requiredFailures: readonly ResolutionFailure[];
    readonly optionalWarnings: readonly string[];
  }>(
    (acc, result, i) => {
      const config = configs[i];
      if (config === undefined) return acc;

      const isOptional = config.required === false;

      if (result.status === "rejected") {
        const message =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        if (isOptional) {
          return {
            middleware: acc.middleware,
            requiredFailures: acc.requiredFailures,
            optionalWarnings: [
              ...acc.optionalWarnings,
              `Optional middleware "${config.name}" skipped: ${message}`,
            ],
          };
        }
        return {
          middleware: acc.middleware,
          requiredFailures: [
            ...acc.requiredFailures,
            {
              section: "middleware" as const,
              index: i,
              name: config.name,
              error: {
                code: "INTERNAL" as const,
                message,
                retryable: RETRYABLE_DEFAULTS.INTERNAL,
                cause: result.reason,
              },
            },
          ],
          optionalWarnings: acc.optionalWarnings,
        };
      }
      if (!result.value.ok) {
        if (isOptional) {
          return {
            middleware: acc.middleware,
            requiredFailures: acc.requiredFailures,
            optionalWarnings: [
              ...acc.optionalWarnings,
              `Optional middleware "${config.name}" skipped: ${result.value.error.message}`,
            ],
          };
        }
        return {
          middleware: acc.middleware,
          requiredFailures: [
            ...acc.requiredFailures,
            {
              section: "middleware" as const,
              index: i,
              name: config.name,
              error: result.value.error,
            },
          ],
          optionalWarnings: acc.optionalWarnings,
        };
      }
      return {
        middleware: [...acc.middleware, result.value.value],
        requiredFailures: acc.requiredFailures,
        optionalWarnings: acc.optionalWarnings,
      };
    },
    { middleware: [], requiredFailures: [], optionalWarnings: [] },
  );

  if (requiredFailures.length > 0) {
    return { ok: false, error: aggregateErrors(requiredFailures) };
  }

  // Sort by priority (default 500, lower = runs first)
  const DEFAULT_PRIORITY = 500;
  const sorted = [...middleware].sort(
    (a, b) => (a.priority ?? DEFAULT_PRIORITY) - (b.priority ?? DEFAULT_PRIORITY),
  );

  return { ok: true, value: { middleware: sorted, warnings: optionalWarnings } };
}
