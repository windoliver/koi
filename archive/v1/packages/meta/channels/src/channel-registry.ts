/**
 * Channel adapter registry — maps channel names to factory functions.
 *
 * Mirrors the MiddlewareRegistry pattern from @koi/starter.
 * The default registry registers all 14+ built-in channel adapters via
 * thin shim modules that validate config and delegate to L2 factories.
 */

import { createAguiShim } from "./adapters/agui.js";
import { createCanvasFallbackShim } from "./adapters/canvas-fallback.js";
import { createChatSdkShim } from "./adapters/chat-sdk.js";
// Adapter shims — eager static imports (shims are tiny config-validation wrappers)
import { createCliShim } from "./adapters/cli.js";
import { createDiscordShim } from "./adapters/discord.js";
import { createEmailShim } from "./adapters/email.js";
import { createMatrixShim } from "./adapters/matrix.js";
import { createMobileShim } from "./adapters/mobile.js";
import { createSignalShim } from "./adapters/signal.js";
import { createSlackShim } from "./adapters/slack.js";
import { createTeamsShim } from "./adapters/teams.js";
import { createTelegramShim } from "./adapters/telegram.js";
import { createVoiceShim } from "./adapters/voice.js";
import { createWhatsappShim } from "./adapters/whatsapp.js";
import type { ChannelFactory, ChannelRegistry } from "./types.js";

/**
 * Creates a ChannelRegistry from a map of name → factory entries.
 */
export function createChannelRegistry(
  entries: ReadonlyMap<string, ChannelFactory>,
): ChannelRegistry {
  return {
    get: (name) => entries.get(name),
    names: () => new Set(entries.keys()),
  };
}

/**
 * Creates the default channel registry with all built-in adapters.
 *
 * Each entry delegates to a thin shim that validates config and calls
 * the L2 adapter factory. Consumers add the L2 channel packages they
 * actually use to their own package.json — this registry only references
 * them via devDependencies for type checking and testing.
 */
export function createDefaultChannelRegistry(): ChannelRegistry {
  const entries = new Map<string, ChannelFactory>([
    ["cli", createCliShim],
    ["slack", createSlackShim],
    ["discord", createDiscordShim],
    ["telegram", createTelegramShim],
    ["teams", createTeamsShim],
    ["email", createEmailShim],
    ["matrix", createMatrixShim],
    ["signal", createSignalShim],
    ["whatsapp", createWhatsappShim],
    ["voice", createVoiceShim],
    ["mobile", createMobileShim],
    ["canvas-fallback", createCanvasFallbackShim],
    ["chat-sdk", createChatSdkShim],
    ["agui", createAguiShim],
  ]);

  return createChannelRegistry(entries);
}
