/**
 * Resolves the channels section of a manifest.
 *
 * If no channels are declared in the manifest, returns undefined
 * (the CLI defaults to channel-cli).
 * Otherwise, resolves each channel by name via the registry.
 */

import type { ChannelAdapter, KoiError, Result } from "@koi/core";
import { aggregateErrors } from "./errors.js";
import { resolveOne } from "./resolve-one.js";
import type { ResolutionContext, ResolutionFailure, ResolveRegistry } from "./types.js";

/** Channel config shape as it appears in the manifest. */
interface ChannelConfig {
  readonly name: string;
  readonly options?: Record<string, unknown>;
}

/**
 * Resolves all declared channels from a manifest.
 *
 * Returns undefined if no channels are declared (CLI falls back to defaults).
 * Resolves all channels in parallel and aggregates failures.
 * Accepts `unknown` because the manifest schema may not fully type this section.
 */
export async function resolveChannels(
  raw: unknown,
  registry: ResolveRegistry,
  context: ResolutionContext,
): Promise<Result<readonly ChannelAdapter[] | undefined, KoiError>> {
  if (raw === undefined || raw === null) {
    return { ok: true, value: undefined };
  }

  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "channels must be an array",
        retryable: false,
      },
    };
  }

  const configs = raw as readonly ChannelConfig[];

  if (configs.length === 0) {
    return { ok: true, value: undefined };
  }

  const results = await Promise.allSettled(
    configs.map((config) => resolveOne<ChannelAdapter>("channel", config, registry, context)),
  );

  const channels: ChannelAdapter[] = [];
  const failures: ResolutionFailure[] = [];

  for (const [i, result] of results.entries()) {
    const config = configs[i];
    if (config === undefined) continue;

    if (result.status === "rejected") {
      failures.push({
        section: "channels",
        index: i,
        name: config.name,
        error: {
          code: "INTERNAL",
          message: result.reason instanceof Error ? result.reason.message : String(result.reason),
          retryable: false,
        },
      });
    } else if (!result.value.ok) {
      failures.push({
        section: "channels",
        index: i,
        name: config.name,
        error: result.value.error,
      });
    } else {
      channels.push(result.value.value);
    }
  }

  if (failures.length > 0) {
    return { ok: false, error: aggregateErrors(failures) };
  }

  return { ok: true, value: channels };
}
