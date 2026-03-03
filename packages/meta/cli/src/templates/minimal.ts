/**
 * Minimal template — bare agent with koi.yaml + project files only.
 */

import type { WizardState } from "../wizard/state.js";
import {
  type FileMap,
  generateManifestYaml,
  generatePackageJson,
  generateReadme,
  generateTsconfig,
} from "./shared.js";

export function generateMinimal(state: WizardState): FileMap {
  return {
    "koi.yaml": generateManifestYaml(state),
    "package.json": generatePackageJson(state),
    "tsconfig.json": generateTsconfig(),
    "README.md": generateReadme(state),
  };
}
