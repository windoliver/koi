/**
 * Setup wizard types — shared between CLI and TUI.
 *
 * Pure type definitions + readonly data constants.
 */

/** Wizard step identifiers. */
export type WizardStepId =
  | "preset"
  | "name"
  | "model"
  | "engine"
  | "channels"
  | "dataSources"
  | "addons";

/** A single wizard step definition. */
export interface WizardStepDefinition {
  readonly id: WizardStepId;
  readonly label: string;
  /** Whether this step is applicable given the current wizard state. */
  readonly isApplicable: (state: SetupWizardState) => boolean;
  /** Validate the value for this step. Returns error string or undefined if valid. */
  readonly validate: (value: unknown, state: SetupWizardState) => string | undefined;
}

/** Complete wizard state. */
export interface SetupWizardState {
  readonly preset: string;
  readonly name: string;
  readonly description: string;
  readonly model: string;
  readonly engine: string | undefined;
  readonly channels: readonly string[];
  readonly addons: readonly string[];
  readonly dataSources: readonly { readonly name: string; readonly protocol: string }[];
  readonly demoPack: string | undefined;
}

/** Default wizard state — sensible starting values. */
export const DEFAULT_SETUP_STATE: SetupWizardState = {
  preset: "local",
  name: "",
  description: "A Koi agent",
  model: "anthropic:claude-sonnet-4-5-20250929",
  engine: undefined,
  channels: ["cli"],
  addons: [],
  dataSources: [],
  demoPack: undefined,
} as const;

/** Phase execution progress. */
export interface PhaseProgress {
  readonly phaseId: string;
  readonly label: string;
  readonly status: "pending" | "running" | "done" | "failed";
  readonly message?: string | undefined;
  readonly error?: string | undefined;
}

/** A phase that can be executed by the PhaseRunner. */
export interface PhaseDefinition<TContext> {
  readonly id: string;
  readonly label: string;
  readonly execute: (ctx: TContext, onProgress: (message: string) => void) => Promise<void>;
}

/** Callbacks for phase lifecycle events. */
export interface PhaseCallbacks {
  readonly onPhaseStart: (phaseId: string, label: string) => void;
  readonly onPhaseProgress: (phaseId: string, message: string) => void;
  readonly onPhaseDone: (phaseId: string) => void;
  readonly onPhaseFailed: (phaseId: string, error: string) => void;
}

/** Error from a failed operation. */
export interface OperationError {
  readonly code: string;
  readonly message: string;
  readonly phase?: string | undefined;
  readonly fix?: string | undefined;
  readonly cause?: unknown;
}

/** Result of an operation — discriminated union. */
export type OperationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: OperationError };

/** Known model identifiers. */
export const KNOWN_MODELS = [
  "anthropic:claude-sonnet-4-5-20250929",
  "openai:gpt-4o",
  "openrouter:anthropic/claude-sonnet-4.6",
] as const;

/** Known channel types. */
export const KNOWN_CHANNELS = ["cli", "telegram", "slack", "discord"] as const;

/** Known preset types. */
export const KNOWN_PRESETS = ["local", "demo", "mesh", "sqlite"] as const;
