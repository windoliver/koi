/**
 * Wizard state — immutable data flowing through the step pipeline.
 * Each step returns a new WizardState with updated fields.
 */

export const TEMPLATES = ["minimal", "copilot"] as const;
export type TemplateName = (typeof TEMPLATES)[number];

export const MODELS = ["anthropic:claude-sonnet-4-5-20250929", "openai:gpt-4o"] as const;

export type EngineName = string;

export const CHANNELS = ["cli", "telegram", "slack", "discord"] as const;
export type ChannelName = (typeof CHANNELS)[number];

export interface WizardState {
  readonly template: TemplateName;
  readonly name: string;
  readonly description: string;
  readonly model: string;
  readonly engine: EngineName | undefined;
  readonly channels: readonly ChannelName[];
  readonly directory: string;
}

export const DEFAULT_STATE: WizardState = {
  template: "minimal",
  name: "",
  description: "A Koi agent",
  model: MODELS[0],
  engine: undefined,
  channels: ["cli"],
  directory: ".",
} as const;
