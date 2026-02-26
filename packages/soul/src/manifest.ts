/**
 * Helpers for wiring @koi/soul from a loaded manifest.
 */

import type { AgentManifest } from "@koi/core/assembly";
import type { ChannelPersonaConfig, CreateSoulOptions } from "./config.js";

/**
 * Extracts per-channel persona configs from an `AgentManifest`, ready to pass
 * as the `identity` field of `CreateSoulOptions`.
 *
 * Channels without an `identity` block are silently skipped.
 * The `channelId` is set to `channel.name` — the exact package name that L1
 * injects into `SessionContext.channelId` (e.g. `"@koi/channel-telegram"`).
 *
 * @example
 * ```ts
 * const mw = await createSoulMiddleware({
 *   ...personasFromManifest(manifest, { basePath: import.meta.dir }),
 * });
 * ```
 */
export function personasFromManifest(
  manifest: AgentManifest,
  options?: { readonly basePath?: string },
): Pick<CreateSoulOptions, "identity"> & { readonly basePath?: string } {
  const personas: readonly ChannelPersonaConfig[] = (manifest.channels ?? []).flatMap((channel) => {
    if (channel.identity === undefined) return [];

    const { name, avatar, instructions } = channel.identity;
    const persona: ChannelPersonaConfig = {
      channelId: channel.name,
      ...(name !== undefined ? { name } : {}),
      ...(avatar !== undefined ? { avatar } : {}),
      ...(instructions !== undefined ? { instructions } : {}),
    };
    return [persona];
  });

  return {
    identity: { personas },
    ...(options?.basePath !== undefined ? { basePath: options.basePath } : {}),
  };
}
