/**
 * Declarative wizard step definitions.
 *
 * Each step has isApplicable (skip conditions) and validate functions.
 */

import type { SetupWizardState, WizardStepDefinition } from "./types.js";
import { validateModel, validateName } from "./validators.js";

/** All wizard steps in order. */
export const WIZARD_STEPS: readonly WizardStepDefinition[] = [
  {
    id: "preset",
    label: "Select preset",
    isApplicable: () => true,
    validate: (value) => {
      if (typeof value !== "string" || value.length === 0) return "Preset is required";
      return undefined;
    },
  },
  {
    id: "name",
    label: "Agent name",
    isApplicable: () => true,
    validate: (value) => {
      if (typeof value !== "string") return "Name must be a string";
      return validateName(value);
    },
  },
  {
    id: "model",
    label: "Select model",
    isApplicable: () => true,
    validate: (value) => {
      if (typeof value !== "string") return "Model must be a string";
      return validateModel(value);
    },
  },
  {
    id: "engine",
    label: "Select engine",
    isApplicable: () => true,
    validate: () => undefined, // Engine is optional
  },
  {
    id: "channels",
    label: "Select channels",
    isApplicable: () => true,
    validate: (value) => {
      if (!Array.isArray(value) || value.length === 0) return "Select at least one channel";
      return undefined;
    },
  },
  {
    id: "dataSources",
    label: "Data sources",
    isApplicable: (state: SetupWizardState) => state.preset !== "demo" && state.preset !== "mesh",
    validate: () => undefined, // Data sources are optional
  },
  {
    id: "addons",
    label: "Add-ons",
    isApplicable: () => true,
    validate: () => undefined, // Add-ons are optional
  },
] as const;
