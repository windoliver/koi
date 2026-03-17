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

import type { OperationResult, PhaseCallbacks, SetupWizardState } from "@koi/setup-core";
import { KNOWN_MODELS } from "@koi/setup-core";
import type { PresetInfo } from "@koi/tui";
import type { TuiFlags } from "../args.js";
import type { RuntimeHandle } from "./up/boot-runtime.js";
import type { StartStackContext } from "./up/start-stack.js";

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
      services: preset.services as unknown as Readonly<Record<string, unknown>>,
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

/**
 * Scaffolds a koi.yaml from the full wizard state, including model, engine,
 * channels, and addons — not just preset and name.
 */
async function scaffoldManifestFromWizard(wizardState: SetupWizardState): Promise<void> {
  const { resolve } = await import("node:path");
  const { DEFAULT_STATE } = await import("../wizard/state.js");
  const { generateManifestYaml, generateDemoManifestYaml } = await import("../templates/shared.js");

  const presetId = wizardState.preset;
  // SetupWizardState.channels is readonly string[]; WizardState.channels
  // requires ChannelName[]. The TUI wizard only offers known channel names,
  // so the cast is safe.
  const channels =
    wizardState.channels.length > 0
      ? (wizardState.channels as typeof DEFAULT_STATE.channels)
      : DEFAULT_STATE.channels;
  const state = {
    ...DEFAULT_STATE,
    name: wizardState.name,
    model: wizardState.model,
    engine: wizardState.engine,
    channels,
    addons: [...wizardState.addons],
    preset: presetId as typeof DEFAULT_STATE.preset,
    template: (presetId === "demo" || presetId === "mesh"
      ? "copilot"
      : "minimal") as typeof DEFAULT_STATE.template,
    ...(wizardState.demoPack !== undefined ? { demoPack: wizardState.demoPack } : {}),
  };

  const yaml =
    presetId === "demo" || presetId === "mesh"
      ? generateDemoManifestYaml(state)
      : generateManifestYaml(state);

  const manifestPath = resolve("koi.yaml");
  await Bun.write(manifestPath, yaml);
}

async function probeAdminHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function runTui(flags: TuiFlags): Promise<void> {
  const adminUrl = flags.url ?? DEFAULT_ADMIN_URL;
  const refreshMs = flags.refresh * 1000;
  let isWelcome = flags.mode === "welcome";

  // Auto-detect: no koi.yaml + no admin → welcome mode
  if (!isWelcome) {
    const { existsSync } = await import("node:fs");
    if (!existsSync("koi.yaml")) {
      const reachable = await probeAdminHealth(adminUrl);
      if (!reachable) {
        isWelcome = true;
      }
    }
  }

  // Dynamic import to keep @koi/tui out of the main CLI bundle
  const { createTuiApp } = await import("@koi/tui");

  // In welcome mode, load presets and wire the selection callback
  const presets = isWelcome ? await loadPresetInfos() : undefined;

  // Captured from startStack context for lifecycle management
  // let justified: set by onStartStack, read by shutdown handler
  let runtimeHandle: RuntimeHandle | undefined;

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
          models: [...KNOWN_MODELS],
          onStartStack: async (
            wizardState: SetupWizardState,
            callbacks: PhaseCallbacks,
          ): Promise<OperationResult<void>> => {
            // 1. Scaffold koi.yaml from full wizard state
            await scaffoldManifestFromWizard(wizardState);

            // 2. Run all phases in-process: validate manifest, preflight,
            //    resolve agent, then boot runtime via bootRuntime()
            const { resolve } = await import("node:path");
            const { startStack } = await import("./up/start-stack.js");
            const ctx: StartStackContext = {
              wizardState,
              manifestPath: resolve("koi.yaml"),
              workspaceRoot: process.cwd(),
              verbose: false,
              adminPort: 3100,
              adminUrl,
              nexusSource: flags.nexusSource,
              nexusBuild: flags.nexusBuild,
              nexusPort: flags.nexusPort,
            };
            const result = await startStack(ctx, callbacks);
            // Capture the runtime handle for lifecycle cleanup on shutdown
            runtimeHandle = ctx.runtimeHandle;
            return result;
          },
          onPresetSelected: async (presetId: string, agentName: string): Promise<void> => {
            // Fallback: scaffold and spawn detached
            await scaffoldManifest(presetId, agentName);

            const { spawn } = await import("node:child_process");
            const bunPath = process.argv[0] ?? "bun";
            const cliEntry = new URL("../bin.ts", import.meta.url).pathname;
            const child = spawn(bunPath, [cliEntry, "up", "--detach"], {
              detached: true,
              stdio: "ignore",
              cwd: process.cwd(),
            });
            child.unref();

            const maxAttempts = 60;
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
              try {
                const res = await fetch(`${adminUrl}/health`, {
                  signal: AbortSignal.timeout(2000),
                });
                if (res.ok) break;
              } catch {
                // Not ready yet
              }
              await new Promise((r) => setTimeout(r, 500));
            }

            await app.transitionToBoardroom();
          },
          onServiceCommand: async (command: string): Promise<void> => {
            const { createAdminClient } = await import("@koi/tui");
            const client = createAdminClient({ baseUrl: adminUrl });
            switch (command) {
              case "stop":
                await client.shutdown();
                break;
              case "doctor": {
                const dispatch = (check: {
                  readonly id: string;
                  readonly label: string;
                  readonly status: "pass" | "fail" | "warn" | "running";
                  readonly detail?: string;
                }): void => {
                  app.store.dispatch({ kind: "append_doctor_check", check });
                };

                dispatch({ id: "manifest", label: "Manifest", status: "running" });
                try {
                  const { loadManifest } = await import("@koi/manifest");
                  const loadResult = await loadManifest("koi.yaml");
                  if (!loadResult.ok) {
                    dispatch({
                      id: "manifest",
                      label: "Manifest",
                      status: "fail",
                      detail: loadResult.error.message,
                    });
                    break;
                  }
                  // Replace running with pass
                  app.store.dispatch({
                    kind: "set_doctor_checks",
                    checks: [
                      {
                        id: "manifest",
                        label: "Manifest",
                        status: "pass",
                        detail: loadResult.value.manifest.name,
                      },
                    ],
                  });

                  dispatch({ id: "admin", label: "Admin API", status: "running" });
                  const healthResult = await client.checkHealth();
                  // Rebuild checks array
                  const checks: {
                    readonly id: string;
                    readonly label: string;
                    readonly status: "pass" | "fail" | "warn" | "running";
                    readonly detail?: string;
                  }[] = [
                    {
                      id: "manifest",
                      label: "Manifest",
                      status: "pass" as const,
                      detail: loadResult.value.manifest.name,
                    },
                    healthResult.ok
                      ? {
                          id: "admin",
                          label: "Admin API",
                          status: "pass" as const,
                          detail: healthResult.value.status,
                        }
                      : {
                          id: "admin",
                          label: "Admin API",
                          status: "fail" as const,
                          detail: healthResult.error.kind,
                        },
                  ];

                  const statusResult = await client.detailedStatus();
                  if (statusResult.ok) {
                    for (const [name, sub] of Object.entries(statusResult.value.subsystems)) {
                      const latency =
                        sub.latencyMs !== undefined ? ` (${String(sub.latencyMs)}ms)` : "";
                      checks.push({
                        id: `sub-${name}`,
                        label: name,
                        status:
                          sub.status === "ready"
                            ? ("pass" as const)
                            : sub.status === "degraded"
                              ? ("warn" as const)
                              : ("fail" as const),
                        detail: `${sub.status}${latency}`,
                      });
                    }
                  }

                  app.store.dispatch({ kind: "set_doctor_checks", checks });
                } catch (err: unknown) {
                  const msg = err instanceof Error ? err.message : String(err);
                  app.store.dispatch({
                    kind: "set_doctor_checks",
                    checks: [{ id: "error", label: "Doctor", status: "fail", detail: msg }],
                  });
                }
                break;
              }
              case "demo-init": {
                const packs = await client.demoPacks();
                if (packs.ok && packs.value.length > 0) {
                  const first = packs.value[0];
                  if (first !== undefined) {
                    await client.demoInit(first.id);
                  }
                }
                break;
              }
              case "demo-reset": {
                const packs = await client.demoPacks();
                if (packs.ok && packs.value.length > 0) {
                  const first = packs.value[0];
                  if (first !== undefined) {
                    await client.demoReset(first.id);
                  }
                }
                break;
              }
              case "demo-list": {
                const packList = await client.demoPacks();
                if (packList.ok) {
                  app.store.dispatch({
                    kind: "set_demo_packs",
                    packs: packList.value.map((p) => ({ id: p.id, description: p.description })),
                  });
                }
                break;
              }
              case "deploy":
                await client.deploy();
                break;
              case "undeploy":
                await client.undeploy();
                break;
            }
          },
        }
      : {}),
  });

  // Graceful shutdown on signals — dispose in-process runtime if started
  const shutdown = async (): Promise<void> => {
    await app.stop();
    if (runtimeHandle !== undefined) {
      await runtimeHandle.dispose();
    }
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
