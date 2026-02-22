/**
 * Wizard state — immutable data flowing through the step pipeline.
 * Each step returns a new WizardState with updated fields.
 */

export const TEMPLATES = ["minimal", "copilot"] as const;
export type TemplateName = (typeof TEMPLATES)[number];

export const MODELS = ["anthropic:claude-sonnet-4-5-20250929", "openai:gpt-4o"] as const;

export const ENGINES = ["loop", "deepagents", "langgraph"] as const;
export type EngineName = (typeof ENGINES)[number];

export const CHANNELS = ["cli", "telegram", "slack", "discord", "web"] as const;
export type ChannelName = (typeof CHANNELS)[number];

export interface WizardState {
  readonly template: TemplateName;
  readonly name: string;
  readonly description: string;
  readonly model: string;
  readonly engine: EngineName;
  readonly channels: readonly ChannelName[];
  readonly directory: string;
}

export const DEFAULT_STATE: WizardState = {
  template: "minimal",
  name: "",
  description: "A Koi agent",
  model: MODELS[0],
  engine: "loop",
  channels: ["cli"],
  directory: ".",
} as const;
