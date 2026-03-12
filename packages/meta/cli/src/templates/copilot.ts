/**
 * Copilot template — persistent agent with channels, working built-in tools,
 * and richer bootstrap guidance.
 */

import type { WizardState } from "../wizard/state.js";
import {
  type FileMap,
  generateBootstrapInstructions,
  generateEnvFile,
  generateGitignore,
  generateManifestYaml,
  generatePackageJson,
  generateReadme,
  generateToolGuide,
  generateTsconfig,
} from "./shared.js";

export function generateCopilot(state: WizardState): FileMap {
  return {
    ".env": generateEnvFile(state),
    ".gitignore": generateGitignore(),
    ".koi/INSTRUCTIONS.md": generateBootstrapInstructions(state),
    ".koi/TOOLS.md": generateToolGuide(),
    "koi.yaml": generateManifestYaml(state),
    "package.json": generatePackageJson(state),
    "tsconfig.json": generateTsconfig(),
    "README.md": generateReadme(state),
  };
}
