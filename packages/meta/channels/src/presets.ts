/**
 * Channel presets — curated sets of adapters for common deployments.
 *
 * Presets define which channels are included by name. The actual adapter
 * configuration still comes from the manifest's channels[] array.
 */

/** CLI only — for local development and testing. */
const MINIMAL = Object.freeze(["cli"] as const);

/** Common messaging platforms for a typical production deployment. */
const STANDARD = Object.freeze(["cli", "slack", "discord", "telegram"] as const);

/** All built-in adapters — for maximum reach. */
const FULL = Object.freeze([
  "cli",
  "slack",
  "discord",
  "telegram",
  "teams",
  "email",
  "matrix",
  "signal",
  "whatsapp",
  "voice",
  "mobile",
  "chat-sdk",
  "agui",
] as const);

import type { ChannelPreset } from "./types.js";

/** Resolves a preset name to its channel list. */
export function resolvePreset(preset: ChannelPreset): readonly string[] {
  switch (preset) {
    case "minimal":
      return MINIMAL;
    case "standard":
      return STANDARD;
    case "full":
      return FULL;
  }
}
