/**
 * `koi init` command — orchestrates wizard pipeline + scaffold.
 */

import { resolve } from "node:path";
import * as p from "@clack/prompts";
import type { CliFlags } from "../args.js";
import { writeScaffold } from "../scaffold.js";
import { generateCopilot } from "../templates/copilot.js";
import { generateMinimal } from "../templates/minimal.js";
import type { FileMap } from "../templates/shared.js";
import { DEFAULT_STATE, type TemplateName, type WizardState } from "../wizard/state.js";
import {
  enterDescription,
  enterName,
  selectChannels,
  selectEngine,
  selectModel,
  selectTemplate,
} from "../wizard/steps.js";

const TEMPLATE_GENERATORS: Readonly<Record<TemplateName, (s: WizardState) => FileMap>> = {
  minimal: generateMinimal,
  copilot: generateCopilot,
};

export async function runInit(flags: CliFlags): Promise<void> {
  p.intro("koi init — create a new agent");

  const directory = flags.directory ?? ".";
  const targetDir = resolve(directory);

  // Build initial state from defaults + directory
  const initialState: WizardState = {
    ...DEFAULT_STATE,
    directory,
  };

  // Run wizard pipeline — each step returns updated state or null (cancelled)
  const steps = [
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

  // Generate files from template
  const generator = TEMPLATE_GENERATORS[state.template];
  const files = generator(state);

  // Write scaffold atomically
  const result = await writeScaffold(targetDir, files);

  if (!result.ok) {
    p.cancel(result.error);
    process.exit(1);
  }

  p.outro(`Agent "${state.name}" created in ${targetDir}`);
}
