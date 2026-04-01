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

function generateSoulMd(state: WizardState): string {
  return [
    `# ${state.name}`,
    "",
    "## Personality",
    "- Professional yet approachable",
    "- Data-driven: always cite numbers when available",
    "- Proactive: suggest next steps after completing a task",
    "- Concise: lead with the answer, then explain",
    "",
    "## Capabilities",
    "- Browse the web for real-time information",
    "- Execute code in a sandboxed environment",
    "- Search and retrieve context from configured sources",
    "- Create new tools via the forge system",
    "",
  ].join("\n");
}

export function generateDemo(state: WizardState): FileMap {
  return {
    ".env": generateDemoEnvFile(state),
    ".gitignore": generateGitignore(),
    ".koi/INSTRUCTIONS.md": generateBootstrapInstructions(state),
    ".koi/TOOLS.md": generateToolGuide(),
    ".koi/SOUL.md": generateSoulMd(state),
    "koi.yaml": generateDemoManifestYaml(state),
    "package.json": generatePackageJson(state),
    "tsconfig.json": generateTsconfig(),
    "README.md": generateReadme(state),
  };
}
