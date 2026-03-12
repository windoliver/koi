/**
 * Wizard step functions — pure pipeline over immutable WizardState.
 *
 * Each step: (state, flags) => Promise<WizardState | null>
 * Returns null when the user cancels (Ctrl+C).
 */

import { basename } from "node:path";
import * as p from "@clack/prompts";
import type { InitFlags } from "../args.js";
import {
  CHANNELS,
  type ChannelName,
  type EngineName,
  MODELS,
  TEMPLATES,
  type TemplateName,
  type WizardState,
} from "./state.js";

type StepResult = WizardState | null;

/** Validates an agent name: lowercase, alphanumeric, hyphens, dots, underscores. */
const VALID_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function isValidName(name: string): boolean {
  return name.length > 0 && name.length <= 214 && VALID_NAME_RE.test(name);
}

export async function selectTemplate(state: WizardState, flags: InitFlags): Promise<StepResult> {
  if (flags.template) {
    if (!(TEMPLATES as readonly string[]).includes(flags.template)) {
      p.cancel(`Unknown template: "${flags.template}". Available: ${TEMPLATES.join(", ")}`);
      return null;
    }
    return { ...state, template: flags.template as TemplateName };
  }
  if (flags.yes) {
    return state;
  }

  const value = await p.select({
    message: "Select a template",
    options: TEMPLATES.map((t) => ({ value: t, label: t })),
  });

  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    return null;
  }

  return { ...state, template: value as TemplateName };
}

export async function enterName(state: WizardState, flags: InitFlags): Promise<StepResult> {
  if (flags.name) {
    if (!isValidName(flags.name)) {
      p.cancel(
        `Invalid name: "${flags.name}". Use lowercase alphanumeric characters, hyphens, dots, or underscores.`,
      );
      return null;
    }
    return { ...state, name: flags.name };
  }

  const defaultName = state.directory === "." ? "koi-agent" : basename(state.directory);

  if (flags.yes) {
    return { ...state, name: defaultName };
  }

  const value = await p.text({
    message: "Agent name",
    placeholder: defaultName,
    defaultValue: defaultName,
    validate: (v) => {
      if (v.trim().length === 0) return "Name cannot be empty";
      if (!isValidName(v))
        return "Use lowercase alphanumeric characters, hyphens, dots, or underscores";
      return undefined;
    },
  });

  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    return null;
  }

  return { ...state, name: value };
}

export async function enterDescription(state: WizardState, flags: InitFlags): Promise<StepResult> {
  if (flags.yes) {
    return state;
  }

  const value = await p.text({
    message: "Description",
    placeholder: state.description,
    defaultValue: state.description,
  });

  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    return null;
  }

  return { ...state, description: value };
}

export async function selectModel(state: WizardState, flags: InitFlags): Promise<StepResult> {
  if (flags.model) {
    if (!(MODELS as readonly string[]).includes(flags.model)) {
      p.cancel(`Unknown model: "${flags.model}". Available: ${MODELS.join(", ")}`);
      return null;
    }
    return { ...state, model: flags.model };
  }
  if (flags.yes) {
    return state;
  }

  const value = await p.select({
    message: "Select a model",
    options: MODELS.map((m) => ({ value: m, label: m })),
  });

  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    return null;
  }

  return { ...state, model: value as string };
}

export async function selectEngine(state: WizardState, flags: InitFlags): Promise<StepResult> {
  if (flags.engine !== undefined) {
    const value = flags.engine.trim();
    if (value.length === 0) {
      p.cancel("Engine cannot be empty.");
      return null;
    }
    return { ...state, engine: value as EngineName };
  }
  return state;
}

export async function selectChannels(state: WizardState, flags: InitFlags): Promise<StepResult> {
  // Only prompt for channels with the copilot template
  if (state.template !== "copilot") {
    return { ...state, channels: ["cli"] };
  }

  if (flags.yes) {
    return { ...state, channels: ["cli"] };
  }

  const value = await p.multiselect({
    message: "Select channels",
    options: CHANNELS.map((c) => ({ value: c, label: c })),
    initialValues: [...state.channels],
    required: true,
  });

  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    return null;
  }

  return { ...state, channels: value as ChannelName[] };
}
