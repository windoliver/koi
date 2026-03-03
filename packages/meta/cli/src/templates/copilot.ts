/**
 * Copilot template — persistent agent with channels, tools, and example code.
 */

import type { WizardState } from "../wizard/state.js";
import {
  type FileMap,
  generateManifestYaml,
  generatePackageJson,
  generateReadme,
  generateTsconfig,
} from "./shared.js";

/** Escapes a string for safe interpolation into generated template literals. */
function escapeForTemplate(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

export function generateCopilot(state: WizardState): FileMap {
  return {
    "koi.yaml": generateManifestYaml(state),
    "package.json": generatePackageJson(state),
    "tsconfig.json": generateTsconfig(),
    "README.md": generateReadme(state),
    "src/tools/hello.ts": generateHelloTool(state),
  };
}

function generateHelloTool(state: WizardState): string {
  const safeName = escapeForTemplate(state.name);
  return `/**
 * Example tool — a simple greeting function.
 * Tools are discovered by the agent via the Resolver contract.
 */

export const descriptor = {
  name: "hello",
  description: "Returns a friendly greeting from ${safeName}",
  parameters: {
    type: "object" as const,
    properties: {
      name: {
        type: "string" as const,
        description: "Name to greet",
      },
    },
    required: ["name"] as const,
  },
} as const;

export async function execute(args: Readonly<Record<string, unknown>>): Promise<string> {
  const name = typeof args.name === "string" ? args.name : "world";
  return \`Hello, \${name}! I'm ${safeName}.\`;
}
`;
}
