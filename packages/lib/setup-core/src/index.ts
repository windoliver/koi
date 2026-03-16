/**
 * @koi/setup-core — Shared wizard validators, step definitions, and phase runner.
 *
 * L0u package: depends on @koi/core only.
 */

export { runPhases } from "./phase-runner.js";
export { WIZARD_STEPS } from "./step-definitions.js";
export type {
  OperationError,
  OperationResult,
  PhaseCallbacks,
  PhaseDefinition,
  PhaseProgress,
  SetupWizardState,
  WizardStepDefinition,
  WizardStepId,
} from "./types.js";
export {
  DEFAULT_SETUP_STATE,
  KNOWN_CHANNELS,
  KNOWN_MODELS,
  KNOWN_PRESETS,
} from "./types.js";
export {
  isValidModel,
  isValidName,
  validateModel,
  validateName,
} from "./validators.js";
