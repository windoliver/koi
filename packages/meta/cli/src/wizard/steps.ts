/**
 * Wizard step functions — pure pipeline over immutable WizardState.
 *
 * Each step: (state, flags) => Promise<WizardState | null>
 * Returns null when the user cancels (Ctrl+C).
 */

import { basename } from "node:path";
import * as p from "@clack/prompts";
import { PROVIDER_ENV_KEYS } from "@koi/model-router";
import { isValidName } from "@koi/setup-core";
import type { InitFlags } from "../args.js";
import {
  CHANNELS,
  type ChannelName,
  type EngineName,
  MODELS,
  PRESETS,
  type PresetName,
  type StackId,
  TEMPLATES,
  type TemplateName,
  type WizardState,
} from "./state.js";

type StepResult = WizardState | null;

const SUPPORTED_MODEL_PROVIDERS = Object.keys(PROVIDER_ENV_KEYS);

export { isValidName } from "@koi/setup-core";

export function isValidModel(name: string): boolean {
  const colonIndex = name.indexOf(":");
  if (colonIndex <= 0 || colonIndex === name.length - 1) {
    return false;
  }

  const provider = name.slice(0, colonIndex);
  return Object.hasOwn(PROVIDER_ENV_KEYS, provider);
}

export async function selectPreset(state: WizardState, flags: InitFlags): Promise<StepResult> {
  if (flags.preset) {
    if (!(PRESETS as readonly string[]).includes(flags.preset)) {
      p.cancel(`Unknown preset: "${flags.preset}". Available: ${PRESETS.join(", ")}`);
      return null;
    }
    return { ...state, preset: flags.preset as PresetName };
  }
  if (flags.yes) {
    return state;
  }

  const value = await p.select({
    message: "Select a runtime preset",
    options: [
      { value: "local", label: "local", hint: "Single agent, local Nexus, no auth" },
      { value: "demo", label: "demo", hint: "Auth-enabled Nexus, seeded data, TUI" },
      { value: "mesh", label: "mesh", hint: "Multi-agent with gateway + Temporal" },
      { value: "sqlite", label: "sqlite", hint: "SQLite persistence for system testing" },
    ],
  });

  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    return null;
  }

  return { ...state, preset: value as PresetName };
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
    const value = flags.model.trim();
    if (!isValidModel(value)) {
      p.cancel(
        `Invalid model: "${flags.model}". Use "provider:model". Supported providers: ${SUPPORTED_MODEL_PROVIDERS.join(", ")}`,
      );
      return null;
    }
    return { ...state, model: value };
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

export async function enterApiKey(state: WizardState, flags: InitFlags): Promise<StepResult> {
  const provider = state.model.split(":")[0];
  const envKey = provider !== undefined ? PROVIDER_ENV_KEYS[provider] : undefined;
  if (envKey === undefined) {
    return state;
  }

  // Skip if already set in environment
  if (process.env[envKey] !== undefined && process.env[envKey] !== "") {
    return state;
  }

  if (flags.yes) {
    return state;
  }

  const value = await p.password({
    message: `${envKey} (required for ${state.model})`,
  });

  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    return null;
  }

  if (value.trim().length === 0) {
    return state;
  }

  return { ...state, apiKey: value.trim() };
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

/**
 * Selects L3 middleware stacks to enable. Only shown for the sqlite preset.
 * Uses grouped multiselect so stacks are organized by test phase.
 */
export async function selectStacks(state: WizardState, flags: InitFlags): Promise<StepResult> {
  if (state.preset !== "sqlite") {
    return state;
  }

  const verified: StackId[] = [
    "toolStack",
    "retryStack",
    "qualityGate",
    "contextArena",
    "contextHub",
    "ace",
  ];

  if (flags.yes) {
    return { ...state, stacks: verified };
  }

  const value = await p.groupMultiselect({
    message: "Select feature stacks to enable",
    initialValues: verified,
    options: {
      "Core (verified)": [
        {
          value: "toolStack" as StackId,
          label: "toolStack",
          hint: "Tool wrapping, error formatting, recovery",
        },
        {
          value: "retryStack" as StackId,
          label: "retryStack",
          hint: "Intelligent retry with backoff",
        },
        {
          value: "qualityGate" as StackId,
          label: "qualityGate",
          hint: "Model call budgets + validation",
        },
      ],
      "Persistence (verified)": [
        {
          value: "contextArena" as StackId,
          label: "contextArena",
          hint: "Multi-turn conversation persistence (SQLite)",
        },
        {
          value: "contextHub" as StackId,
          label: "contextHub",
          hint: "chub_search + chub_get tools",
        },
        {
          value: "ace" as StackId,
          label: "ace",
          hint: "Adaptive Continuous Enhancement (SQLite)",
        },
      ],
    },
  });

  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    return null;
  }

  return { ...state, stacks: value as StackId[] };
}

/**
 * Scans environment for common data source patterns (e.g., DATABASE_URL)
 * and offers to include them in the manifest.
 * Skipped for demo/mesh presets (those get sources from Nexus).
 */
export async function selectDataSources(state: WizardState, flags: InitFlags): Promise<StepResult> {
  // Demo/mesh presets get data sources via Nexus seeding, not wizard
  if (state.preset === "demo" || state.preset === "mesh") {
    return state;
  }

  if (flags.yes) {
    return state;
  }

  try {
    const { probeEnv } = await import("@koi/data-source-discovery");
    const results = probeEnv(process.env as Readonly<Record<string, string | undefined>>, [
      "*DATABASE_URL*",
      "*_DSN",
      "*_CONNECTION_STRING",
    ]);

    if (results.length === 0) {
      return state;
    }

    const sources: { readonly name: string; readonly protocol: string }[] = [];
    for (const result of results) {
      const confirmed = await p.confirm({
        message: `Found ${result.descriptor.name} (${result.descriptor.protocol}). Add as data source?`,
      });

      if (p.isCancel(confirmed)) {
        p.cancel("Setup cancelled.");
        return null;
      }

      if (confirmed) {
        sources.push({
          name: result.descriptor.name,
          protocol: result.descriptor.protocol,
        });
      }
    }

    return { ...state, dataSources: sources };
  } catch {
    // Discovery not available — skip gracefully
    return state;
  }
}
