/**
 * Demo template — preset-aware agent with auth-enabled Nexus,
 * autonomous mode, and demo seeding support.
 */

import type { WizardState } from "../wizard/state.js";
import {
  type FileMap,
  generateBootstrapInstructions,
  generateDemoEnvFile,
  generateDemoManifestYaml,
  generateGitignore,
  generatePackageJson,
  generateReadme,
  generateToolGuide,
  generateTsconfig,
} from "./shared.js";

export function generateDemo(state: WizardState): FileMap {
  return {
    ".env": generateDemoEnvFile(state),
    ".gitignore": generateGitignore(),
    ".koi/INSTRUCTIONS.md": generateBootstrapInstructions(state),
    ".koi/TOOLS.md": generateToolGuide(),
    "koi.yaml": generateDemoManifestYaml(state),
    "package.json": generatePackageJson(state),
    "tsconfig.json": generateTsconfig(),
    "README.md": generateReadme(state),
  };
}
