/**
 * Helpers for wiring @koi/identity from a loaded manifest.
 */

import type { AgentManifest } from "@koi/core/assembly";
import type { ChannelPersonaConfig, CreateIdentityOptions } from "./config.js";

/**
 * Extracts per-channel persona configs from an `AgentManifest`, ready to pass
 * directly to `createIdentityMiddleware`.
 *
 * Channels without an `identity` block are silently skipped.
 * The `channelId` is set to `channel.name` — the exact package name that L1
 * injects into `SessionContext.channelId` (e.g. `"@koi/channel-telegram"`).
 *
 * @example
 * ```ts
 * const mw = await createIdentityMiddleware(
 *   personasFromManifest(manifest, { basePath: import.meta.dir }),
 * );
 * ```
 */
export function personasFromManifest(
  manifest: AgentManifest,
  options?: { readonly basePath?: string },
): CreateIdentityOptions {
  const personas: ChannelPersonaConfig[] = [];

  for (const channel of manifest.channels ?? []) {
    if (channel.identity === undefined) continue;

    const { name, avatar, instructions } = channel.identity;
    const persona: ChannelPersonaConfig = {
      channelId: channel.name,
      ...(name !== undefined ? { name } : {}),
      ...(avatar !== undefined ? { avatar } : {}),
      ...(instructions !== undefined ? { instructions } : {}),
    };
    personas.push(persona);
  }

  return {
    personas,
    ...(options?.basePath !== undefined ? { basePath: options.basePath } : {}),
  };
}
