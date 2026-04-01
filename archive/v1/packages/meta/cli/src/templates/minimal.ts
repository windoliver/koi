/**
 * Minimal template — bare agent with koi.yaml + project files only.
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
  generateTsconfig,
} from "./shared.js";

export function generateMinimal(state: WizardState): FileMap {
  return {
    ".env": generateEnvFile(state),
    ".gitignore": generateGitignore(),
    ".koi/INSTRUCTIONS.md": generateBootstrapInstructions(state),
    "koi.yaml": generateManifestYaml(state),
    "package.json": generatePackageJson(state),
    "tsconfig.json": generateTsconfig(),
    "README.md": generateReadme(state),
  };
}
