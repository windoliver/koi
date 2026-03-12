/**
 * Add-on definitions — optional extensions that can be added to any preset
 * via `koi init --with <addon>`.
 */

import type { AddOn } from "./types.js";

export const ADDON_TELEGRAM: AddOn = {
  id: "telegram",
  label: "Telegram",
  description: "Telegram bot channel",
  packageName: "@koi/channel-telegram",
  channelName: "@koi/channel-telegram",
  envKeys: [{ key: "TELEGRAM_BOT_TOKEN", label: "Telegram bot token" }],
} as const;

export const ADDON_SLACK: AddOn = {
  id: "slack",
  label: "Slack",
  description: "Slack bot channel",
  packageName: "@koi/channel-slack",
  channelName: "@koi/channel-slack",
  envKeys: [
    { key: "SLACK_BOT_TOKEN", label: "Slack bot token" },
    { key: "SLACK_APP_TOKEN", label: "Slack app token" },
  ],
} as const;

export const ADDON_DISCORD: AddOn = {
  id: "discord",
  label: "Discord",
  description: "Discord bot channel",
  packageName: "@koi/channel-discord",
  channelName: "@koi/channel-discord",
  envKeys: [
    { key: "DISCORD_BOT_TOKEN", label: "Discord bot token" },
    { key: "DISCORD_APPLICATION_ID", label: "Discord application ID" },
  ],
} as const;

export const ADDON_TEMPORAL: AddOn = {
  id: "temporal",
  label: "Temporal",
  description: "Temporal workflow orchestration",
  packageName: "@temporalio/client",
  channelName: undefined,
  envKeys: [],
} as const;

export const ADDON_MCP: AddOn = {
  id: "mcp",
  label: "MCP",
  description: "Model Context Protocol bridge",
  packageName: "@koi/mcp-bridge",
  channelName: undefined,
  envKeys: [],
} as const;

export const ADDON_BROWSER: AddOn = {
  id: "browser",
  label: "Browser",
  description: "Browser automation tools",
  packageName: "@koi/tools-browser",
  channelName: undefined,
  envKeys: [],
} as const;

export const ADDON_VOICE: AddOn = {
  id: "voice",
  label: "Voice",
  description: "Voice channel (WebRTC)",
  packageName: "@koi/channel-voice",
  channelName: "@koi/channel-voice",
  envKeys: [],
} as const;

/** All known add-ons indexed by ID. */
export const ADDONS: Readonly<Record<string, AddOn>> = {
  telegram: ADDON_TELEGRAM,
  slack: ADDON_SLACK,
  discord: ADDON_DISCORD,
  temporal: ADDON_TEMPORAL,
  mcp: ADDON_MCP,
  browser: ADDON_BROWSER,
  voice: ADDON_VOICE,
} as const;

/** Available add-on IDs (for validation and CLI help). */
export const ADDON_IDS = Object.keys(ADDONS) as readonly string[];
