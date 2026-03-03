/**
 * Shared template generators — reused across all templates.
 * Each function is pure: (state) → string.
 */

import type { WizardState } from "../wizard/state.js";

/** File map: relative filepath → file content. */
export type FileMap = Readonly<Record<string, string>>;

/**
 * Generates a koi.yaml manifest from wizard state.
 * Uses hand-crafted YAML for readability and control over formatting.
 */
export function generateManifestYaml(state: WizardState): string {
  const lines: string[] = [];
  lines.push(`name: ${state.name}`);
  lines.push("version: 0.1.0");
  lines.push(`description: ${state.description}`);
  lines.push(`model: "${state.model}"`);
  lines.push(`engine: ${state.engine}`);

  // Only include channels section if there are non-cli channels
  const nonCliChannels = state.channels.filter((c) => c !== "cli");
  if (nonCliChannels.length > 0) {
    lines.push("channels:");
    for (const channel of nonCliChannels) {
      lines.push(`  - name: "@koi/channel-${channel}"`);
      lines.push(`    options:`);
      lines.push(`      token: \${${channel.toUpperCase()}_BOT_TOKEN}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Generates a package.json for the scaffolded project.
 */
export function generatePackageJson(state: WizardState): string {
  const pkg = {
    name: state.name,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "koi dev",
      start: "koi start",
    },
    dependencies: {
      "@koi/core": "latest",
    },
  };

  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/**
 * Generates a tsconfig.json for the scaffolded project.
 */
export function generateTsconfig(): string {
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noUncheckedIndexedAccess: true,
      verbatimModuleSyntax: true,
      esModuleInterop: true,
      skipLibCheck: true,
      outDir: "dist",
      rootDir: "src",
    },
    include: ["src/**/*"],
  };

  return `${JSON.stringify(tsconfig, null, 2)}\n`;
}

/**
 * Generates a README.md for the scaffolded project.
 */
export function generateReadme(state: WizardState): string {
  const lines: string[] = [];
  lines.push(`# ${state.name}`);
  lines.push("");
  lines.push(state.description);
  lines.push("");
  lines.push("## Getting Started");
  lines.push("");
  lines.push("```bash");
  lines.push("bun install");
  lines.push("bun run dev");
  lines.push("```");
  lines.push("");
  lines.push("## Configuration");
  lines.push("");
  lines.push("Edit `koi.yaml` to configure your agent's model, tools, channels, and middleware.");
  lines.push("");

  return lines.join("\n");
}
