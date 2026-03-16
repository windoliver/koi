/**
 * `koi tui` — Interactive terminal console for operators.
 *
 * Connects to a running admin API and provides:
 * - Agent list with live refresh
 * - Agent console with AG-UI chat streaming
 * - Command palette for agent management
 *
 * In welcome mode (no manifest):
 * - Shows preset picker from @koi/runtime-presets
 * - On selection: scaffolds koi.yaml, runs `koi up`, transitions to boardroom
 *
 * Usage:
 *   koi tui --url http://localhost:3100/admin/api
 *   koi tui --url http://localhost:3100/admin/api --token my-secret
 *   koi tui --refresh 10
 */

import type { PresetInfo } from "@koi/tui";
import type { TuiFlags } from "../args.js";

const DEFAULT_ADMIN_URL = "http://localhost:3100/admin/api";

/**
 * Builds PresetInfo[] from @koi/runtime-presets and @koi/demo-packs.
 * Dynamic imports keep these out of the main CLI bundle.
 */
async function loadPresetInfos(): Promise<readonly PresetInfo[]> {
  const { PRESET_IDS, getPreset } = await import("@koi/runtime-presets");
  const { getPack } = await import("@koi/demo-packs");

  return PRESET_IDS.map((id) => {
    const preset = getPreset(id);
    const pack = preset.demoPack !== undefined ? getPack(preset.demoPack) : undefined;

    return {
      id: preset.id,
      description: preset.description,
      nexusMode: preset.nexusMode,
      demoPack: preset.demoPack,
      services: preset.services as Readonly<Record<string, unknown>>,
      stacks: preset.stacks as Readonly<Record<string, boolean | undefined>>,
      ...(pack !== undefined
        ? {
            agentRoles: pack.agentRoles.map((r) => ({
              role: r.name,
              description: r.description,
            })),
            prompts: pack.prompts,
          }
        : {}),
    };
  });
}

/**
 * Scaffolds a koi.yaml in the current directory for the selected preset.
 * Uses the template generators from the init pipeline.
 */
async function scaffoldManifest(presetId: string, agentName: string): Promise<void> {
  const { resolve } = await import("node:path");
  const { DEFAULT_STATE } = await import("../wizard/state.js");
  const { generateManifestYaml, generateDemoManifestYaml } = await import("../templates/shared.js");

  const state = {
    ...DEFAULT_STATE,
    name: agentName,
    preset: presetId as typeof DEFAULT_STATE.preset,
    // Demo/mesh presets use copilot template with richer manifest
    template: (presetId === "demo" || presetId === "mesh"
      ? "copilot"
      : "minimal") as typeof DEFAULT_STATE.template,
    ...(presetId === "demo" ? { demoPack: "connected" } : {}),
  };

  const yaml =
    presetId === "demo" || presetId === "mesh"
      ? generateDemoManifestYaml(state)
      : generateManifestYaml(state);

  const manifestPath = resolve("koi.yaml");
  await Bun.write(manifestPath, yaml);
}

export async function runTui(flags: TuiFlags): Promise<void> {
  const adminUrl = flags.url ?? DEFAULT_ADMIN_URL;
  const refreshMs = flags.refresh * 1000;
  const isWelcome = flags.mode === "welcome";

  // Dynamic import to keep @koi/tui out of the main CLI bundle
  const { createTuiApp } = await import("@koi/tui");

  // In welcome mode, load presets and wire the selection callback
  const presets = isWelcome ? await loadPresetInfos() : undefined;

  const app = createTuiApp({
    adminUrl,
    refreshIntervalMs: refreshMs,
    ...(isWelcome ? { mode: "welcome" as const } : {}),
    ...(presets !== undefined ? { presets } : {}),
    ...(flags.authToken !== undefined ? { authToken: flags.authToken } : {}),
    ...(flags.agent !== undefined ? { initialAgentId: flags.agent } : {}),
    ...(flags.session !== undefined ? { initialSessionId: flags.session } : {}),
    ...(isWelcome
      ? {
          onPresetSelected: async (presetId: string, agentName: string): Promise<void> => {
            // 1. Scaffold koi.yaml with the selected preset
            await scaffoldManifest(presetId, agentName);

            // 2. Run `koi up` in-process (imports dynamically to avoid circular deps)
            const { runUp } = await import("./up.js");
            await runUp({
              command: "up",
              directory: undefined,
              manifest: undefined,
              verbose: false,
              detach: false,
              web: false,
              timing: false,
              nexusUrl: undefined,
              nexusBuild: false,
              nexusSource: undefined,
              nexusPort: undefined,
              temporalUrl: undefined,
              logFormat: "text",
            });

            // 3. Transition the TUI from welcome to boardroom
            await app.transitionToBoardroom();
          },
        }
      : {}),
  });

  // Graceful shutdown on signals
  const shutdown = async (): Promise<void> => {
    await app.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    shutdown().catch(() => {
      process.exit(1);
    });
  });
  process.on("SIGTERM", () => {
    shutdown().catch(() => {
      process.exit(1);
    });
  });

  if (!isWelcome) {
    process.stderr.write(`Connecting to ${adminUrl}…\n`);
  }
  await app.start();
}
