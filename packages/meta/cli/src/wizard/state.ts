/**
 * Wizard state — immutable data flowing through the step pipeline.
 * Each step returns a new WizardState with updated fields.
 *
 * Shared constants imported from @koi/setup-core; CLI-specific types defined here.
 */

import { KNOWN_CHANNELS, KNOWN_MODELS, KNOWN_PRESETS } from "@koi/setup-core";

export const TEMPLATES = ["minimal", "copilot"] as const;
export type TemplateName = (typeof TEMPLATES)[number];

export const MODELS: typeof KNOWN_MODELS = KNOWN_MODELS;

export type EngineName = string;

export const CHANNELS: typeof KNOWN_CHANNELS = KNOWN_CHANNELS;
export type ChannelName = (typeof CHANNELS)[number];

export const PRESETS: typeof KNOWN_PRESETS = KNOWN_PRESETS;
export type PresetName = (typeof PRESETS)[number];

export interface WizardState {
  readonly template: TemplateName;
  readonly name: string;
  readonly description: string;
  readonly model: string;
  readonly engine: EngineName | undefined;
  readonly channels: readonly ChannelName[];
  readonly directory: string;
  readonly koiCommand: string;
  /** Runtime preset (local, demo, mesh). */
  readonly preset: PresetName;
  /** Add-on IDs selected via --with flag. */
  readonly addons: readonly string[];
  /** Demo pack ID to auto-seed. */
  readonly demoPack: string | undefined;
  /** Discovered data sources from env probing. */
  readonly dataSources: readonly { readonly name: string; readonly protocol: string }[];
  /** API key for the selected model provider (entered during init). */
  readonly apiKey: string | undefined;
}

export const DEFAULT_STATE: WizardState = {
  template: "minimal",
  name: "",
  description: "A Koi agent",
  model: MODELS[0],
  engine: undefined,
  channels: ["cli"],
  directory: ".",
  koiCommand: "koi",
  preset: "local",
  addons: [],
  demoPack: undefined,
  dataSources: [],
  apiKey: undefined,
} as const;
