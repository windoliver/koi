/**
 * Shared types for the `koi up` phase pipeline.
 */

import type { ChannelAdapter } from "@koi/core";
import type { NexusMode, PresetId } from "@koi/runtime-presets";

export interface ProvisionedAgent {
  readonly name: string;
  readonly role: string;
}

export interface BannerInfo {
  readonly agentName: string;
  readonly presetId: PresetId;
  readonly nexusMode: NexusMode;
  readonly engineName: string;
  readonly modelName: string;
  readonly channels: readonly ChannelAdapter[];
  readonly nexusBaseUrl: string | undefined;
  readonly adminReady: boolean;
  readonly temporalAdmin: { readonly dispose: () => Promise<void> } | undefined;
  readonly temporalUrl: string | undefined;
  readonly provisionedAgents: readonly ProvisionedAgent[];
  readonly discoveredSources: readonly { readonly name: string; readonly protocol: string }[];
  readonly prompts: readonly string[];
}
