/**
 * `koi init` command — orchestrates wizard pipeline + scaffold.
 *
 * Supports preset-aware initialization:
 * - `koi init myagent --preset demo --with telegram`
 * - `koi init myagent --yes` (defaults)
 */

import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { ADDON_IDS, resolveAddons } from "@koi/runtime-presets";
import type { InitFlags } from "../args.js";
import { resolveScaffoldKoiCommand } from "../local-cli.js";
import { writeScaffold } from "../scaffold.js";
import { generateCopilot } from "../templates/copilot.js";
import { generateDemo } from "../templates/demo.js";
import { generateMinimal } from "../templates/minimal.js";
import type { FileMap } from "../templates/shared.js";
import { DEFAULT_STATE, type TemplateName, type WizardState } from "../wizard/state.js";
import {
  enterDescription,
  enterName,
  selectChannels,
  selectEngine,
  selectModel,
  selectPreset,
  selectTemplate,
} from "../wizard/steps.js";

const TEMPLATE_GENERATORS: Readonly<Record<string, (s: WizardState) => FileMap>> = {
  minimal: generateMinimal,
  copilot: generateCopilot,
  demo: generateDemo,
};

export async function runInit(flags: InitFlags): Promise<void> {
  p.intro("koi init — create a new agent");

  const directory = flags.directory ?? ".";
  const targetDir = resolve(directory);

  // Validate --with add-on IDs
  if (flags.withAddons.length > 0) {
    const { unknown } = resolveAddons(flags.withAddons);
    if (unknown.length > 0) {
      p.cancel(`Unknown add-on(s): ${unknown.join(", ")}. Available: ${ADDON_IDS.join(", ")}`);
      process.exit(1);
    }
  }

  // Build initial state from defaults + directory + flags
  const initialState: WizardState = {
    ...DEFAULT_STATE,
    directory,
    addons: [...flags.withAddons],
    ...(flags.demo !== undefined ? { demoPack: flags.demo } : {}),
  };

  // Run wizard pipeline — each step returns updated state or null (cancelled)
  const steps = [
    selectPreset,
    selectTemplate,
    enterName,
    enterDescription,
    selectModel,
    selectEngine,
    selectChannels,
  ];

  let state: WizardState = initialState;
  for (const step of steps) {
    const result = await step(state, flags);
    if (result === null) {
      process.exit(0);
    }
    state = result;
  }

  // Apply preset-specific template overrides
  state = applyPresetDefaults(state);

  state = {
    ...state,
    koiCommand: resolveScaffoldKoiCommand(targetDir),
  };

  // Select generator: demo preset uses demo template, otherwise use wizard template
  const generatorKey = state.preset === "demo" || state.preset === "mesh" ? "demo" : state.template;
  const generator = TEMPLATE_GENERATORS[generatorKey];
  if (generator === undefined) {
    p.cancel(`Unknown template: "${generatorKey}"`);
    process.exit(1);
  }
  const files = generator(state);

  // Write scaffold atomically
  const result = await writeScaffold(targetDir, files);

  if (!result.ok) {
    p.cancel(result.error);
    process.exit(1);
  }

  // Print next steps
  const cdHint = directory !== "." ? `cd ${directory} && ` : "";
  p.outro(`Agent "${state.name}" created in ${targetDir}`);

  if (state.preset === "demo" || state.preset === "mesh") {
    process.stderr.write(`\nNext steps:\n  ${cdHint}koi up\n\n`);
  } else {
    process.stderr.write(`\nNext steps:\n  ${cdHint}bun run start:admin\n\n`);
  }
}

/**
 * Applies preset-specific defaults to wizard state.
 * Demo and mesh presets auto-set the template to copilot and enable demo packs.
 */
function applyPresetDefaults(state: WizardState): WizardState {
  switch (state.preset) {
    case "demo":
      return {
        ...state,
        template: "copilot" as TemplateName,
        demoPack: state.demoPack ?? "connected",
      };
    case "mesh":
      return {
        ...state,
        template: "copilot" as TemplateName,
      };
    default:
      return state;
  }
}
