/**
 * Shared template generators — reused across all templates.
 * Each function is pure: (state) → string.
 */

import { PROVIDER_ENV_KEYS } from "@koi/model-router";
import type { ChannelName, WizardState } from "../wizard/state.js";

/** File map: relative filepath → file content. */
export type FileMap = Readonly<Record<string, string>>;

/** Channel-specific environment variable keys — shared across all template generators. */
const CHANNEL_ENV_KEYS: Readonly<Record<Exclude<ChannelName, "cli">, readonly string[]>> = {
  telegram: ["TELEGRAM_BOT_TOKEN"],
  slack: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
  discord: ["DISCORD_BOT_TOKEN", "DISCORD_APPLICATION_ID"],
} as const;

/** Maps add-on IDs to their channel package names. */
const ADDON_CHANNEL_MAP: Readonly<Record<string, string>> = {
  telegram: "@koi/channel-telegram",
  slack: "@koi/channel-slack",
  discord: "@koi/channel-discord",
} as const;

function getModelEnvKey(model: string): string | undefined {
  const [provider] = model.split(":", 1);
  return provider !== undefined && provider.length > 0 ? PROVIDER_ENV_KEYS[provider] : undefined;
}

function getSelectedChannelEnvKeys(channels: readonly ChannelName[]): readonly {
  readonly channel: Exclude<ChannelName, "cli">;
  readonly envKeys: readonly string[];
}[] {
  return channels
    .filter((channel): channel is Exclude<ChannelName, "cli"> => channel !== "cli")
    .map((channel) => ({ channel, envKeys: CHANNEL_ENV_KEYS[channel] }));
}

// ---------------------------------------------------------------------------
// Manifest core — shared header + channels for generateManifestYaml / generateDemoManifestYaml
// ---------------------------------------------------------------------------

interface ManifestCoreOptions {
  readonly nexusComment: string;
  readonly includeAddonChannels?: boolean;
  readonly additionalSections?: readonly string[];
}

/**
 * Builds the shared manifest header (name, version, description, model, engine, preset),
 * nexus guidance comment, and channels section. Returns a mutable lines array so callers
 * can append template-specific sections before joining.
 */
function generateManifestCore(state: WizardState, options: ManifestCoreOptions): string[] {
  const lines: string[] = [];
  lines.push(`name: ${state.name}`);
  lines.push("version: 0.1.0");
  lines.push(`description: ${state.description}`);
  lines.push(`model: "${state.model}"`);
  if (state.engine !== undefined && state.engine !== "pi") {
    lines.push(`engine: ${state.engine}`);
  }
  lines.push(`preset: ${state.preset}`);
  lines.push("");
  lines.push(options.nexusComment);
  lines.push("# nexus:");
  lines.push("#   url: https://nexus.example.com");
  lines.push("");

  lines.push("channels:");
  lines.push(`  - name: "@koi/channel-cli"`);

  const nonCliChannels = state.channels.filter((c) => c !== "cli");
  for (const channel of nonCliChannels) {
    lines.push(`  - name: "@koi/channel-${channel}"`);
  }

  if (options.includeAddonChannels === true) {
    for (const addon of state.addons) {
      const channelName = ADDON_CHANNEL_MAP[addon];
      if (channelName !== undefined) {
        lines.push(`  - name: "${channelName}"`);
      }
    }
  }

  if (options.additionalSections !== undefined) {
    for (const section of options.additionalSections) {
      lines.push(section);
    }
  }

  return lines;
}

/**
 * Generates a koi.yaml manifest from wizard state.
 * Uses hand-crafted YAML for readability and control over formatting.
 */
export function generateManifestYaml(state: WizardState): string {
  const additional: string[] = [];

  if (state.dataSources.length > 0) {
    additional.push("");
    additional.push("dataSources:");
    for (const ds of state.dataSources) {
      additional.push(`  - name: ${ds.name}`);
      additional.push(`    protocol: ${ds.protocol}`);
    }
  }

  if (state.template === "copilot") {
    additional.push("");
    additional.push("tools:");
    additional.push("  koi:");
    additional.push('    - name: "@koi/tool-ask-user"');
    additional.push('    - name: "@koi/tools-web"');
    additional.push('    - name: "@koi/tools-context-hub"');
    additional.push('    - name: "@koi/tool-exec"');
    additional.push('    - name: "@koi/tool-browser"');
  }

  if (state.preset === "sqlite") {
    additional.push("");
    additional.push("storage:");
    additional.push("  driver: sqlite");

    if (state.stacks.length > 0) {
      additional.push("");
      additional.push("stacks:");
      for (const stack of state.stacks) {
        additional.push(`  ${stack}: true`);
      }
      // Use sqlite backends when persistence stacks are enabled
      if (state.stacks.includes("contextArena")) {
        additional.push("  threadStoreBackend: sqlite");
      }
      if (state.stacks.includes("ace")) {
        additional.push("  aceStoreBackend: sqlite");
      }
    }
  }

  additional.push("");
  additional.push("context:");
  additional.push("  bootstrap: true");
  additional.push("");

  const lines = generateManifestCore(state, {
    nexusComment:
      "# Leave nexus.url unset for local embed mode.\n# Add it only when you want remote/shared Nexus.",
    additionalSections: additional,
  });

  return lines.join("\n");
}

/**
 * Generates a package.json for the scaffolded project.
 */
export function generatePackageJson(state: WizardState): string {
  const scripts = {
    koi: state.koiCommand,
    up: "bun run koi -- up",
    "dry-run": "bun run koi -- start --dry-run",
    start: "bun run koi -- start",
    "start:admin": "bun run koi -- start --admin",
    serve: "bun run koi -- serve",
    "serve:admin": "bun run koi -- serve --admin",
    admin: "bun run koi -- admin",
    tui: "bun run koi -- tui",
    "tui:serve": "bun run koi -- tui --url http://localhost:9100/admin/api",
    doctor: "bun run koi -- doctor",
  };

  const pkg = {
    name: state.name,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts,
    ...(state.koiCommand === "koi" ? { dependencies: { koi: "latest" } } : {}),
  };

  return `${JSON.stringify(pkg, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Env core — shared header + model key + channel keys for env file generators
// ---------------------------------------------------------------------------

interface EnvCoreOptions {
  readonly nexusApiKey?: string;
  readonly includeAddonKeys?: boolean;
  readonly additionalSections?: readonly string[];
}

/**
 * Builds the shared .env header (auto-load comment), model env key, optional
 * Nexus API key, optional add-on channel keys, and selected channel env keys.
 * Returns a mutable lines array so callers can append template-specific
 * sections before joining.
 */
function generateEnvCore(state: WizardState, options: EnvCoreOptions): string[] {
  const lines: string[] = [];
  lines.push("# Bun auto-loads .env for `bun run` commands.");
  lines.push("");

  const modelEnvKey = getModelEnvKey(state.model);
  if (modelEnvKey !== undefined) {
    lines.push(`# Required for ${state.model}`);
    lines.push(`${modelEnvKey}=${state.apiKey ?? ""}`);
    lines.push("");
  }

  if (options.nexusApiKey !== undefined) {
    lines.push("# Demo Nexus API key (auto-generated for local auth mode)");
    lines.push(`NEXUS_API_KEY=${options.nexusApiKey}`);
    lines.push("");
  }

  if (options.includeAddonKeys === true) {
    for (const addon of state.addons) {
      const keys = CHANNEL_ENV_KEYS[addon as Exclude<ChannelName, "cli">];
      if (keys !== undefined) {
        lines.push(`# ${addon[0]?.toUpperCase() ?? ""}${addon.slice(1)} channel`);
        for (const key of keys) {
          lines.push(`${key}=`);
        }
        lines.push("");
      }
    }
  }

  const selectedChannelEnvKeys = getSelectedChannelEnvKeys(state.channels);
  for (const { channel, envKeys } of selectedChannelEnvKeys) {
    lines.push(`# ${channel[0]?.toUpperCase() ?? ""}${channel.slice(1)} channel`);
    for (const envKey of envKeys) {
      const entered = state.channelTokens[envKey];
      lines.push(`${envKey}=${entered ?? ""}`);
    }
    lines.push("");
  }

  if (options.additionalSections !== undefined) {
    for (const section of options.additionalSections) {
      lines.push(section);
    }
  }

  return lines;
}

/**
 * Generates a .env file with the credentials implied by the selected model/channels.
 */
export function generateEnvFile(state: WizardState): string {
  const additional: string[] = [];

  if (state.template === "copilot") {
    additional.push("# Optional: enable web_search via Brave Search");
    additional.push("# BRAVE_API_KEY=");
    additional.push("");
  }

  additional.push("# Optional: remote/shared Nexus");
  additional.push("# NEXUS_URL=https://nexus.example.com");
  additional.push("# NEXUS_API_KEY=");
  additional.push("");

  const lines = generateEnvCore(state, {
    additionalSections: additional,
  });

  return lines.join("\n");
}

/**
 * Generates a basic .gitignore for scaffolded agent projects.
 */
export function generateGitignore(): string {
  return `${[".env", "dist", "node_modules"].join("\n")}\n`;
}

/**
 * Generates bootstrap instructions loaded via context.bootstrap.
 */
export function generateBootstrapInstructions(state: WizardState): string {
  const lines: string[] = [];
  lines.push(`# ${state.name}`);
  lines.push("");
  lines.push(
    `You are "${state.name}". Always identify yourself by this name, not by the underlying model.`,
  );
  lines.push("");
  lines.push(`Goal: ${state.description}`);
  lines.push("");
  lines.push("Operating rules:");
  lines.push("- Be concise, practical, and honest about uncertainty.");
  lines.push("- Prefer using the configured tools and live sources over stale assumptions.");
  lines.push("- If credentials or local services are missing, explain exactly what is needed.");
  if (state.template === "copilot") {
    lines.push("- Use `ask_user` when a decision needs user confirmation or missing requirements.");
    lines.push("- Use web tools to verify current facts before answering when freshness matters.");
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Generates tool guidance for the copilot template bootstrap path.
 */
export function generateToolGuide(): string {
  return [
    "# Tool Guide",
    "",
    "- `ask_user`: stop and collect structured clarification instead of guessing.",
    "- `web_fetch`: retrieve and inspect a known URL.",
    "- `web_search`: search for current information when you do not already have a URL.",
    "",
  ].join("\n");
}

/**
 * Generates a koi.yaml manifest for the demo preset.
 * Includes forge, autonomous mode, soul, context sources, data sources,
 * and auth-enabled Nexus.
 */
export function generateDemoManifestYaml(state: WizardState): string {
  const additional: string[] = [];

  additional.push("");
  additional.push("forge:");
  additional.push("  enabled: true");
  additional.push("");

  additional.push("autonomous:");
  additional.push("  enabled: true");
  additional.push("");

  additional.push('soul: ".koi/SOUL.md"');
  additional.push("");

  additional.push("tools:");
  additional.push("  koi:");
  additional.push('    - name: "@koi/tool-ask-user"');
  additional.push('    - name: "@koi/tools-web"');
  additional.push('    - name: "@koi/tool-exec"');
  additional.push('    - name: "@koi/tools-context-hub"');
  additional.push('    - name: "@koi/tool-browser"');
  additional.push("");

  additional.push("forge:");
  additional.push("  enabled: true");
  additional.push("");

  if (state.demoPack !== undefined) {
    additional.push("demo:");
    additional.push(`  pack: ${state.demoPack}`);
    additional.push("");
  }

  additional.push("dataSources:");
  additional.push("  - name: herb-employees");
  additional.push("    protocol: nexus");
  additional.push("  - name: herb-customers");
  additional.push("    protocol: nexus");
  additional.push("  - name: herb-products");
  additional.push("    protocol: nexus");
  additional.push("");

  additional.push("context:");
  additional.push("  bootstrap: true");
  additional.push("");

  const lines = generateManifestCore(state, {
    nexusComment: "# Demo preset: auth-enabled local Nexus (API key auto-generated in .env).",
    includeAddonChannels: true,
    additionalSections: additional,
  });

  return lines.join("\n");
}

/**
 * Generates a .env file for the demo preset with auto-generated Nexus API key.
 */
export function generateDemoEnvFile(state: WizardState): string {
  const additional: string[] = [];
  additional.push("# Optional: enable web_search via Brave Search");
  additional.push("# BRAVE_API_KEY=");
  additional.push("");

  const lines = generateEnvCore(state, {
    nexusApiKey: generateLocalApiKey(),
    includeAddonKeys: true,
    additionalSections: additional,
  });

  return lines.join("\n");
}

/** Generates a random hex string suitable for a local API key. */
function generateLocalApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `sk-koi-demo-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
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
  const usesLocalCli = state.koiCommand !== "koi";
  lines.push(`# ${state.name}`);
  lines.push("");
  lines.push(state.description);
  lines.push("");
  lines.push("## Setup");
  lines.push("");
  if (usesLocalCli) {
    lines.push("This scaffold is wired to the local Koi monorepo CLI.");
    lines.push("");
    lines.push(
      `The generated \`koi\` script points to \`${state.koiCommand}\`, so you can run it from this repo checkout without installing a separate package.`,
    );
    lines.push("");
    lines.push("If you rebuild the CLI, run `bun run build:cli` at the repo root.");
    lines.push("");
  } else {
    lines.push("This scaffold targets the single-package `koi` distribution.");
    lines.push("");
    lines.push("```bash");
    lines.push("bun install");
    lines.push("```");
    lines.push("");
  }
  lines.push("Then fill in `.env` with the API key for your selected model.");
  lines.push("");
  if (!usesLocalCli) {
    lines.push(
      "If you are running inside the Koi monorepo before `koi` is published, keep using the repo root CLI instead:",
    );
    lines.push("");
    lines.push("```bash");
    lines.push("bun run koi -- start --dry-run path/to/koi.yaml");
    lines.push("bun run koi -- start --admin path/to/koi.yaml");
    lines.push("bun run koi -- tui");
    lines.push("```");
    lines.push("");
  }
  lines.push("Local Nexus embed mode also expects `uv run nexus` to be available on your `PATH`.");
  lines.push("");
  lines.push("## First Run");
  lines.push("");
  lines.push("The quickest way to start is `koi up`, which launches the runtime,");
  lines.push("admin API, and TUI in a single command:");
  lines.push("");
  lines.push("```bash");
  lines.push("bun run up");
  lines.push("```");
  lines.push("");
  lines.push("This starts:");
  lines.push("- Agent runtime on your configured model");
  lines.push("- Admin panel at `http://localhost:3100/admin`");
  lines.push("- TUI operator console (for demo/mesh presets)");
  lines.push("- Health endpoint at `http://localhost:9100/health`");
  lines.push("");
  lines.push("For a dry run (validate config without starting): `bun run dry-run`");
  lines.push("");
  lines.push("## Advanced Usage");
  lines.push("");
  lines.push("```bash");
  lines.push("bun run start:admin   # Start runtime + admin (no TUI)");
  lines.push("bun run serve:admin   # Service mode with admin on port 9100");
  lines.push("bun run tui           # Attach TUI to a running admin API");
  lines.push("bun run admin         # Standalone admin panel on port 9200");
  lines.push("```");
  lines.push("");
  lines.push("## Nexus Mode");
  lines.push("");
  lines.push("Leave `nexus.url` unset for local embed mode.");
  lines.push("When you want remote/shared Nexus, change only the URL:");
  lines.push("");
  lines.push("```yaml");
  lines.push("nexus:");
  lines.push("  url: https://nexus.example.com");
  lines.push("```");
  lines.push("");
  lines.push("## Configuration");
  lines.push("");
  lines.push("Edit `koi.yaml`, `.env`, and `.koi/INSTRUCTIONS.md` to shape the agent.");
  if (state.template === "copilot") {
    lines.push(
      "The copilot template also includes `.koi/TOOLS.md` and built-in web + ask-user tools.",
    );
  }
  lines.push("");

  return lines.join("\n");
}
