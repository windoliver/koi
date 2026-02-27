/**
 * Per-platform ChannelCapabilities constants.
 *
 * Each platform declares what content block types it supports natively.
 * Unsupported blocks are downgraded by renderBlocks() from @koi/channel-base.
 */

import type { ChannelCapabilities } from "@koi/core";
import type { PlatformName } from "./config.js";

const SLACK_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: true,
  files: true,
  buttons: true,
  audio: false,
  video: false,
  threads: true,
  supportsA2ui: false,
} as const satisfies ChannelCapabilities;

const DISCORD_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: true,
  files: true,
  buttons: true,
  audio: false,
  video: false,
  threads: true,
  supportsA2ui: false,
} as const satisfies ChannelCapabilities;

const TEAMS_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: true,
  files: true,
  buttons: true,
  audio: false,
  video: false,
  threads: true,
  supportsA2ui: false,
} as const satisfies ChannelCapabilities;

const GCHAT_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: true,
  files: false,
  buttons: true,
  audio: false,
  video: false,
  threads: true,
  supportsA2ui: false,
} as const satisfies ChannelCapabilities;

const GITHUB_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: true,
  files: false,
  buttons: false,
  audio: false,
  video: false,
  threads: true,
  supportsA2ui: false,
} as const satisfies ChannelCapabilities;

const LINEAR_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: true,
  files: false,
  buttons: false,
  audio: false,
  video: false,
  threads: true,
  supportsA2ui: false,
} as const satisfies ChannelCapabilities;

const CAPABILITIES_MAP: Readonly<Record<PlatformName, ChannelCapabilities>> = {
  slack: SLACK_CAPABILITIES,
  discord: DISCORD_CAPABILITIES,
  teams: TEAMS_CAPABILITIES,
  gchat: GCHAT_CAPABILITIES,
  github: GITHUB_CAPABILITIES,
  linear: LINEAR_CAPABILITIES,
} as const;

export function capabilitiesForPlatform(platform: PlatformName): ChannelCapabilities {
  return CAPABILITIES_MAP[platform];
}
