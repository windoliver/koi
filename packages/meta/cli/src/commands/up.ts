/**
 * `koi up` command — single command to start runtime + admin + TUI.
 *
 * Startup sequence:
 * 1. RESOLVE:   Find manifest (./koi.yaml default)
 * 2. VALIDATE:  Load + validate manifest
 * 3. PRESET:    Resolve runtime preset from manifest metadata
 * 4. PREFLIGHT: Check API keys, channel tokens, binary availability
 * 5. SPAWN:     Start Nexus embed (deferred health check)
 * 6. TEMPORAL:  Auto-start Temporal if preset requires it
 * 7. RESOLVE:   Parallel resolve all subsystems
 * 8. ASSEMBLE:  Create engine + middleware + providers
 * 9. START:     Create runtime, connect channels
 * 10. ADMIN:    Start admin API server
 * 11. TUI:      Attach TUI (if preset enables it)
 * 12. BANNER:   Print URLs, channel state, agent readiness
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createCliChannel } from "@koi/channel-cli";
import { createContextExtension } from "@koi/context";
import type { ChannelAdapter, EngineEvent, EngineInput } from "@koi/core";
import type { AdminPanelBridgeResult, DashboardHandlerResult } from "@koi/dashboard-api";
import { createAdminPanelBridge, createDashboardHandler } from "@koi/dashboard-api";
import { createPiAdapter } from "@koi/engine-pi";
import { createForgeConfiguredKoi } from "@koi/forge";
import { getEngineName, loadManifest } from "@koi/manifest";
import type { NexusMode, PresetId, PresetServices } from "@koi/runtime-presets";
import { resolveRuntimePreset } from "@koi/runtime-presets";
import { EXIT_CONFIG } from "@koi/shutdown";
import type { TemporalEmbedHandle } from "@koi/temporal";
import { createAgentDispatcher } from "../agent-dispatcher.js";
import type { AgentChatBridge } from "../agui-chat-bridge.js";
import type { UpFlags } from "../args.js";
import { bootstrapForgeOrWarn } from "../bootstrap-forge.js";
import { createChatRouter } from "../chat-router.js";
import { composeRuntimeMiddleware } from "../compose-middleware.js";
import {
  createLocalFileSystem,
  extractTextFromBlocks,
  persistChatExchangeSafely,
  resolveDashboardAssetsDir,
} from "../helpers.js";
import { formatResolutionError, resolveAgent } from "../resolve-agent.js";
import { resolveAutonomousOrWarn } from "../resolve-autonomous.js";
import { mergeBootstrapContext } from "../resolve-bootstrap.js";
import { resolveNexusOrWarn } from "../resolve-nexus.js";
import { resolveOrchestrationFromAgent } from "../resolve-orchestration.js";
import { resolveTemporalOrWarn } from "../resolve-temporal.js";
import { printPreflightIssues, validateManifestPrerequisites } from "../validate-preflight.js";

// ---------------------------------------------------------------------------
// Timing instrumentation
// ---------------------------------------------------------------------------

interface TimingEntry {
  readonly label: string;
  readonly durationMs: number;
}

function createTimer(enabled: boolean): {
  readonly time: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  readonly print: () => void;
} {
  const entries: TimingEntry[] = [];
  const startTime = performance.now();

  return {
    time: async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
      if (!enabled) return fn();
      const start = performance.now();
      const result = await fn();
      entries.push({ label, durationMs: Math.round(performance.now() - start) });
      return result;
    },
    print: () => {
      if (!enabled) return;
      process.stderr.write("\n");
      for (const entry of entries) {
        const padded = entry.label.padEnd(14);
        process.stderr.write(`[timing] ${padded} ${String(entry.durationMs)}ms\n`);
      }
      const total = Math.round(performance.now() - startTime);
      process.stderr.write(`[timing] ${"total".padEnd(14)} ${String(total)}ms\n`);
    },
  };
}

// ---------------------------------------------------------------------------
// Event rendering
// ---------------------------------------------------------------------------

function renderEvent(event: EngineEvent, verbose: boolean): void {
  switch (event.kind) {
    case "text_delta":
      process.stdout.write(event.delta);
      break;
    case "tool_call_start":
      if (verbose) {
        process.stderr.write(`\n[tool] ${event.toolName}...\n`);
      }
      break;
    case "tool_call_end":
      if (verbose) {
        process.stderr.write("[tool] done\n");
      }
      break;
    case "done":
      process.stdout.write("\n");
      if (verbose) {
        const m = event.output.metrics;
        process.stderr.write(`[${m.turns} turn(s), ${m.totalTokens} tokens, ${m.durationMs}ms]\n`);
      }
      break;
    case "turn_end":
    case "custom":
    case "discovery:miss":
    case "spawn_requested":
      break;
  }
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function runUp(flags: UpFlags): Promise<void> {
  // 0. DETACH: Fork child process and exit parent
  if (flags.detach) {
    const { spawn } = await import("node:child_process");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");

    const manifestPath = flags.manifest ?? flags.directory ?? "koi.yaml";
    const workspaceRoot = resolve(dirname(manifestPath));

    const args = process.argv.slice(1).filter((a) => a !== "--detach");
    const child = spawn(process.argv[0] ?? "bun", args, {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();

    const pidDir = join(workspaceRoot, ".koi");
    await mkdir(pidDir, { recursive: true });
    await writeFile(join(pidDir, "koi.pid"), String(child.pid));
    process.stderr.write(`Detached. PID ${String(child.pid)} written to .koi/koi.pid\n`);
    process.exit(0);
  }

  const timer = createTimer(flags.timing);

  // 1. RESOLVE: Find manifest path
  const manifestPath = flags.manifest ?? flags.directory ?? "koi.yaml";
  const workspaceRoot = resolve(dirname(manifestPath));

  // 2. VALIDATE: Load and validate manifest
  const loadResult = await timer.time("manifest", () => loadManifest(manifestPath));
  if (!loadResult.ok) {
    process.stderr.write(`Failed to load manifest: ${loadResult.error.message}\n`);
    process.exit(EXIT_CONFIG);
  }

  const { manifest, warnings } = loadResult.value;
  for (const warning of warnings) {
    process.stderr.write(`warn: ${warning.message}\n`);
  }

  const engineName = getEngineName(manifest);
  const modelName = manifest.model.name;

  // 3. PRESET: Resolve runtime preset (needed for preflight + service startup)
  const presetId = await timer.time("preset", async () => inferPresetId(manifestPath));
  const { resolved: preset } = resolveRuntimePreset(presetId);
  const services: PresetServices = preset.services;

  // 4. PREFLIGHT: Validate prerequisites (preset-aware)
  const temporalAutoStart = services.temporal === "auto" && flags.temporalUrl === undefined;
  const preflight = await timer.time("preflight", async () =>
    validateManifestPrerequisites(manifest, process.env, {
      temporalRequired: temporalAutoStart,
    }),
  );
  if (!printPreflightIssues(preflight)) {
    process.stderr.write("Preflight checks failed. Fix errors above and retry.\n");
    process.exit(EXIT_CONFIG);
  }

  if (flags.verbose) {
    process.stderr.write(
      `Preset: ${presetId} (tui=${String(services.tui)}` +
        `, temporal=${services.temporal}, gateway=${String(services.gateway)})\n`,
    );
  }

  // 5. Bootstrap forge system
  // let justified: tracks session ID for forge counter scoping
  let currentSessionId = `up:${manifest.name}:0`;
  let sessionCounter = 0;

  const forgeResult = await timer.time("forge", () =>
    bootstrapForgeOrWarn(manifest, () => currentSessionId, flags.verbose),
  );
  const forgeBootstrap = forgeResult?.bootstrap;
  const sandboxBridge = forgeResult?.sandboxBridge;

  // 5. Create AG-UI chat bridge for admin chat
  const { createAgentChatBridge } = await import("../agui-chat-bridge.js");
  const chatBridge: AgentChatBridge = createAgentChatBridge();

  // 6. RESOLVE: Agent + subsystems in parallel
  const resolved = await timer.time("resolve", () =>
    resolveAgent({
      manifestPath,
      manifest,
      ...(forgeBootstrap !== undefined ? { forgeStore: forgeBootstrap.store } : {}),
    }),
  );
  if (!resolved.ok) {
    process.stderr.write(formatResolutionError(resolved.error));
    if (sandboxBridge !== undefined) await sandboxBridge.dispose();
    process.exit(EXIT_CONFIG);
  }

  const adapter = resolved.value.engine ?? createPiAdapter({ model: modelName });

  // Auto-start Nexus via `nexus up` (Docker Compose) for auth-enabled presets only.
  // embed-lite (local) uses the legacy ensureNexusRunning() path inside resolveNexusOrWarn().
  // embed-auth (demo/mesh) uses nexus up which manages Docker Compose services.
  let nexusBaseUrl = flags.nexusUrl ?? manifest.nexus?.url ?? process.env.NEXUS_URL;
  let nexusStartedByUs = false;

  if (nexusBaseUrl === undefined && preset.nexusMode === "embed-auth") {
    const nexusResult = await timer.time("nexus-up", () =>
      startNexusStack(workspaceRoot, presetId, flags.verbose),
    );
    if (nexusResult !== undefined) {
      nexusBaseUrl = nexusResult.baseUrl;
      nexusStartedByUs = true;
    }
  }

  // Auto-start Temporal when preset requires it and no explicit URL given
  let temporalEmbedHandle: TemporalEmbedHandle | undefined;
  let temporalUrl = flags.temporalUrl;

  if (temporalAutoStart) {
    temporalEmbedHandle = await timer.time("temporal-embed", async () =>
      startTemporalEmbed(flags.verbose),
    );
    if (temporalEmbedHandle !== undefined) {
      temporalUrl = temporalEmbedHandle.url;
    }
  }

  // For embed-lite (local), pass profile so legacy ensureNexusRunning() uses correct mode.
  // For embed-auth, nexusBaseUrl is already set by nexusUp() above.
  const embedProfile = nexusStartedByUs ? undefined : mapNexusModeToProfile(preset.nexusMode);

  // Resolve Nexus, autonomous, temporal in parallel (preset controls Temporal)
  const [nexus, autonomous, temporalAdmin] = await timer.time("subsystems", () =>
    Promise.all([
      resolveNexusOrWarn(nexusBaseUrl, manifest.nexus?.url, flags.verbose, embedProfile),
      resolveAutonomousOrWarn(manifest, flags.verbose),
      temporalUrl !== undefined
        ? resolveTemporalOrWarn(temporalUrl, flags.verbose)
        : Promise.resolve(undefined),
    ]),
  );

  // 7. ASSEMBLE: Wire runtime
  const contextConfig = await mergeBootstrapContext(manifest.context, manifestPath, manifest.name);
  const contextExt = createContextExtension(contextConfig);
  const extensions = contextExt !== undefined ? [contextExt] : [];

  const composed = composeRuntimeMiddleware({
    resolved: resolved.value.middleware,
    nexus,
    forge: forgeBootstrap,
    autonomous,
    chatBridge,
  });

  const { runtime } = await timer.time("runtime", () =>
    createForgeConfiguredKoi({
      manifest,
      adapter,
      middleware: composed.middleware,
      providers: composed.providers,
      extensions,
      ...(forgeBootstrap !== undefined ? { forge: forgeBootstrap.runtime } : {}),
    }),
  );

  // 8. Connect channels
  const channels: readonly ChannelAdapter[] = resolved.value.channels ?? [createCliChannel()];
  for (const ch of channels) {
    await ch.connect();
  }

  // 9. ADMIN: Start admin API server (always enabled in koi up)
  const DEFAULT_ADMIN_PORT = 3100;
  let stopAdmin: (() => void) | undefined;
  let adminBridge: AdminPanelBridgeResult | undefined;
  let adminDispatcher: ReturnType<typeof createAgentDispatcher> | undefined;
  let adminReady = false;

  try {
    const channelNames = channels.map((ch) => ch.name);
    const skillNames = (manifest.skills ?? []).map((s) => s.name);

    const orch = resolveOrchestrationFromAgent({
      agent: runtime.agent,
      temporal: temporalAdmin,
      ...(autonomous !== undefined ? { harness: autonomous.harness } : {}),
      verbose: flags.verbose,
    });

    const dispatcher = createAgentDispatcher({
      defaultManifestPath: manifestPath,
      verbose: flags.verbose,
      additionalMiddleware: [
        ...nexus.middlewares,
        ...(forgeBootstrap?.middlewares ?? []),
        ...(autonomous?.middleware ?? []),
      ],
      additionalProviders: [
        ...nexus.providers,
        ...(forgeBootstrap !== undefined
          ? [forgeBootstrap.provider, forgeBootstrap.forgeToolsProvider]
          : []),
        ...(autonomous?.providers ?? []),
      ],
      additionalExtensions: extensions,
      ...(forgeBootstrap !== undefined
        ? { forgeStore: forgeBootstrap.store, forgeRuntime: forgeBootstrap.runtime }
        : {}),
    });
    adminDispatcher = dispatcher;

    adminBridge = createAdminPanelBridge({
      agentName: manifest.name,
      agentType: manifest.lifecycle ?? "copilot",
      model: modelName,
      channels: channelNames,
      skills: skillNames,
      fileSystem: createLocalFileSystem(workspaceRoot),
      dispatchAgent: dispatcher.dispatchAgent,
      onTerminateAgent: async (id) => {
        await dispatcher.terminateAgent(id);
      },
      ...(orch.hasAny
        ? {
            orchestration: orch.orchestration,
            orchestrationCommands: orch.orchestrationCommands,
          }
        : {}),
    });

    const routingChatHandler = createChatRouter({
      primaryHandler: chatBridge.handler,
      getDispatchedHandler: dispatcher.getChatHandler,
      isPrimaryAgent: (id) => id === adminBridge?.agentId,
    });

    const assetsDir = resolveDashboardAssetsDir();
    const dashboardResult: DashboardHandlerResult = createDashboardHandler(
      {
        ...adminBridge,
        agentChatHandler: routingChatHandler,
      },
      {
        cors: true,
        ...(assetsDir !== undefined ? { assetsDir } : {}),
      },
    );

    const server = await timer.time("admin", async () =>
      Bun.serve({
        port: DEFAULT_ADMIN_PORT,
        async fetch(req: Request): Promise<Response> {
          const adminResponse = await dashboardResult.handler(req);
          if (adminResponse !== null) return adminResponse;
          return new Response("Not Found", { status: 404 });
        },
      }),
    );

    stopAdmin = () => {
      server.stop(true);
      dashboardResult.dispose();
    };
    adminReady = true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`warn: admin panel failed to start: ${message}\n`);
    adminBridge = undefined;
  }

  const persistAgentId = adminBridge?.agentId ?? manifest.name;

  // 9b. Auto-seed demo pack if configured in manifest
  await seedDemoPackIfNeeded(
    manifestPath,
    workspaceRoot,
    manifest.name,
    nexus.baseUrl,
    flags.verbose,
  );

  // 9c. Auto-provision helper agents from demo pack agentRoles
  const provisionedAgents = await provisionDemoAgents(manifestPath, adminDispatcher, flags.verbose);

  // 10. Start health server (mirrors serve.ts health endpoint)
  const DEFAULT_HEALTH_PORT = 9100;
  const healthPort = manifest.deploy?.port ?? DEFAULT_HEALTH_PORT;
  let stopHealth: (() => void) | undefined;

  try {
    const { createHealthServer } = await import("@koi/deploy");
    const healthServer = createHealthServer({
      port: healthPort,
      onReady: () => true,
    });
    const healthInfo = await healthServer.start();
    stopHealth = () => healthServer.stop();
    if (flags.verbose) {
      process.stderr.write(`Health server: ${healthInfo.url}\n`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`warn: health server failed to start: ${message}\n`);
  }

  // 11. Print startup banner
  timer.print();
  printBanner({
    agentName: manifest.name,
    presetId,
    nexusMode: preset.nexusMode,
    engineName,
    modelName,
    channels,
    nexusBaseUrl: nexus.baseUrl,
    adminReady,
    temporalAdmin,
    temporalUrl,
    provisionedAgents,
  });

  // 12. Attach TUI (requires admin API + preset enables it)
  let tuiApp:
    | { readonly start: () => Promise<void>; readonly stop: () => Promise<void> }
    | undefined;
  let tuiAttached = false;
  if (adminReady && services.tui) {
    try {
      const { createTuiApp } = await import("@koi/tui");
      tuiApp = createTuiApp({
        adminUrl: `http://localhost:${String(DEFAULT_ADMIN_PORT)}/admin/api`,
      });
      await tuiApp.start();
      tuiAttached = true;
    } catch {
      tuiApp = undefined;
    }
  }

  if (tuiAttached) {
    process.stderr.write("Operator console attached.\n\n");
  } else {
    process.stderr.write("Type a message or Ctrl+C to stop.\n\n");
  }

  // 13. Set up shutdown + REPL
  const controller = new AbortController();
  let shuttingDown = false;

  function shutdown(): void {
    if (shuttingDown) {
      process.stderr.write("\nForce exit.\n");
      process.exit(1);
    }
    shuttingDown = true;
    process.stderr.write("\nShutting down...\n");
    controller.abort();
  }

  process.on("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // REPL loop with processing guard (fallback when TUI is unavailable)
  let processing = false;

  chatBridge.wireDispatch(async (msg) => {
    if (processing) {
      throw new Error("Agent is busy processing another request");
    }
    processing = true;
    try {
      const text = extractTextFromBlocks(msg.content);
      if (text.trim() === "") return;
      const threadId = msg.threadId ?? `chat-${Date.now().toString(36)}`;
      const input: EngineInput = { kind: "text", text };
      const deltas: string[] = [];
      for await (const event of runtime.run(input)) {
        if (event.kind === "text_delta") deltas.push(event.delta);
        if (event.kind === "done" && adminBridge !== undefined) {
          const m = event.output.metrics;
          adminBridge.updateMetrics({ turns: m.turns, totalTokens: m.totalTokens });
        }
      }
      await persistChatExchangeSafely(
        workspaceRoot,
        persistAgentId,
        threadId,
        text,
        deltas.join(""),
      );
    } finally {
      processing = false;
    }
  });

  const unsubscribers = channels.map((ch) =>
    ch.onMessage(async (inbound) => {
      const text = extractTextFromBlocks(inbound.content);
      if (text.trim() === "") return;

      if (processing) {
        process.stderr.write("(busy — please wait for the current response)\n");
        return;
      }

      processing = true;
      sessionCounter++;
      currentSessionId = `up:${manifest.name}:${String(sessionCounter)}`;
      const input: EngineInput = { kind: "text", text };

      try {
        const deltas: string[] = [];
        for await (const event of runtime.run(input)) {
          if (controller.signal.aborted) break;
          renderEvent(event, flags.verbose);
          if (event.kind === "text_delta") deltas.push(event.delta);
          if (event.kind === "done" && adminBridge !== undefined) {
            const m = event.output.metrics;
            adminBridge.updateMetrics({ turns: m.turns, totalTokens: m.totalTokens });
          }
        }
        await persistChatExchangeSafely(
          workspaceRoot,
          persistAgentId,
          currentSessionId,
          text,
          deltas.join(""),
        );
      } catch (error: unknown) {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`Error: ${message}\n`);
        }
      } finally {
        processing = false;
      }
    }),
  );

  // Wait for abort signal
  await new Promise<void>((r) => {
    controller.signal.addEventListener("abort", () => r(), { once: true });
  });

  // Cleanup
  process.removeListener("SIGINT", shutdown);
  process.removeListener("SIGTERM", shutdown);
  if (tuiApp !== undefined) await tuiApp.stop();
  for (const unsub of unsubscribers) {
    unsub();
  }
  for (const ch of channels) {
    await ch.disconnect();
  }
  if (stopHealth !== undefined) stopHealth();
  if (stopAdmin !== undefined) stopAdmin();
  if (adminDispatcher !== undefined) await adminDispatcher.dispose();
  if (temporalAdmin !== undefined) await temporalAdmin.dispose();
  if (temporalEmbedHandle !== undefined) await temporalEmbedHandle.dispose();
  await runtime.dispose();
  if (autonomous !== undefined) await autonomous.dispose();
  forgeBootstrap?.dispose();
  if (sandboxBridge !== undefined) await sandboxBridge.dispose();
  if (nexus.dispose !== undefined) await nexus.dispose();

  // Stop Nexus stack if we started it
  if (nexusStartedByUs) {
    await stopNexusStack(workspaceRoot, flags.verbose);
  }

  process.stderr.write("Goodbye.\n");
}

// ---------------------------------------------------------------------------
// Temporal auto-start
// ---------------------------------------------------------------------------

/**
 * Auto-starts a local Temporal dev server via `@koi/temporal` embed mode.
 * Returns the embed handle (with gRPC URL + dispose) or undefined on failure.
 */
async function startTemporalEmbed(verbose: boolean): Promise<TemporalEmbedHandle | undefined> {
  try {
    const { ensureTemporalRunning } = await import("@koi/temporal");
    const handle = await ensureTemporalRunning();
    if (verbose) {
      process.stderr.write(`Temporal: auto-started at ${handle.url} (UI: ${handle.uiUrl})\n`);
    }
    return handle;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`warn: Temporal auto-start failed: ${message}\n`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Nexus mode mapping (legacy embed-lite path)
// ---------------------------------------------------------------------------

/** Maps preset nexusMode to the embed profile for `nexus serve --profile <x>`. */
function mapNexusModeToProfile(mode: NexusMode): string | undefined {
  switch (mode) {
    case "embed-lite":
      return "lite";
    case "embed-auth":
      return "full";
    case "remote":
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Nexus lifecycle (nexus up / nexus down)
// ---------------------------------------------------------------------------

interface NexusStartResult {
  readonly baseUrl: string;
}

/**
 * Starts the Nexus stack via `nexus up` (Docker Compose lifecycle).
 * Auto-runs `nexus init` if `nexus.yaml` is missing in the workspace.
 */
async function startNexusStack(
  workspaceRoot: string,
  koiPreset: string,
  verbose: boolean,
): Promise<NexusStartResult | undefined> {
  try {
    const { nexusUp } = await import("@koi/nexus-embed");
    const result = await nexusUp({ cwd: workspaceRoot, koiPreset, verbose });
    if (!result.ok) {
      process.stderr.write(`warn: nexus up failed: ${result.error.message}\n`);
      return undefined;
    }
    if (verbose && result.value.autoInitialized) {
      process.stderr.write("Nexus: auto-initialized nexus.yaml\n");
    }
    return { baseUrl: result.value.baseUrl };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`warn: Nexus startup failed: ${message}\n`);
    return undefined;
  }
}

/** Stops the Nexus stack via `nexus down`. Best-effort, logs warnings. */
async function stopNexusStack(workspaceRoot: string, verbose: boolean): Promise<void> {
  try {
    const { nexusDown } = await import("@koi/nexus-embed");
    const result = await nexusDown({ cwd: workspaceRoot, verbose });
    if (!result.ok) {
      process.stderr.write(`warn: nexus down failed: ${result.error.message}\n`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`warn: Nexus shutdown failed: ${message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Preset inference
// ---------------------------------------------------------------------------

/**
 * Infers the runtime preset from manifest YAML.
 * Reads `preset:` field if present, falls back to heuristics.
 */
async function inferPresetId(manifestPath: string): Promise<PresetId> {
  try {
    const raw = await readFile(manifestPath, "utf-8");
    const presetMatch = /^preset:\s*(\S+)/m.exec(raw);
    if (presetMatch?.[1] !== undefined) {
      const id = presetMatch[1];
      if (id === "local" || id === "demo" || id === "mesh") return id;
    }
    // Infer demo from demo.pack presence
    if (/^demo:\s*\n\s+pack:/m.test(raw)) return "demo";
    return "local";
  } catch {
    return "local";
  }
}

// ---------------------------------------------------------------------------
// Demo pack seeding
// ---------------------------------------------------------------------------

async function seedDemoPackIfNeeded(
  manifestPath: string,
  workspaceRoot: string,
  agentName: string,
  nexusBaseUrl: string | undefined,
  verbose: boolean,
): Promise<void> {
  try {
    const { join } = await import("node:path");

    const raw = await readFile(manifestPath, "utf-8");
    const demoMatch = /^demo:\s*\n\s+pack:\s*(\S+)/m.exec(raw);
    if (demoMatch === null) return;

    const packId = demoMatch[1];
    if (packId === undefined) return;

    const markerPath = join(workspaceRoot, ".koi", ".demo-seeded");
    try {
      await readFile(markerPath, "utf-8");
      return;
    } catch {
      // Marker doesn't exist — proceed with seeding
    }

    if (nexusBaseUrl === undefined) {
      process.stderr.write("warn: demo pack requires Nexus — skipping auto-seed\n");
      return;
    }

    const { runSeed } = await import("@koi/demo-packs");
    const { createNexusClient } = await import("@koi/nexus-client");
    const apiKey = process.env.NEXUS_API_KEY;
    const nexusClient = createNexusClient({
      baseUrl: nexusBaseUrl,
      ...(apiKey !== undefined ? { apiKey } : {}),
    });

    const result = await runSeed(packId, {
      nexusClient,
      agentName,
      workspaceRoot,
      verbose,
    });

    for (const line of result.summary) {
      process.stderr.write(`  ${line}\n`);
    }

    if (result.ok) {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const pidDir = join(workspaceRoot, ".koi");
      await mkdir(pidDir, { recursive: true });
      await writeFile(markerPath, packId);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`warn: demo pack seeding failed: ${message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Demo agent provisioning
// ---------------------------------------------------------------------------

interface ProvisionedAgent {
  readonly name: string;
  readonly role: string;
}

/**
 * Provisions helper agents declared in the demo pack's agentRoles.
 * Skips the "primary" role (already running as the main runtime).
 */
async function provisionDemoAgents(
  manifestPath: string,
  dispatcher: ReturnType<typeof createAgentDispatcher> | undefined,
  verbose: boolean,
): Promise<readonly ProvisionedAgent[]> {
  if (dispatcher === undefined) return [];

  try {
    const raw = await readFile(manifestPath, "utf-8");
    const demoMatch = /^demo:\s*\n\s+pack:\s*(\S+)/m.exec(raw);
    if (demoMatch === null) return [];

    const packId = demoMatch[1];
    if (packId === undefined) return [];

    const { getPack } = await import("@koi/demo-packs");
    const pack = getPack(packId);
    if (pack === undefined) return [];

    const provisioned: ProvisionedAgent[] = [];

    for (const role of pack.agentRoles) {
      // Skip the primary agent — it's already running as the main runtime
      if (role.name === "primary") continue;

      const result = await dispatcher.dispatchAgent({
        name: `${role.name} (${role.type})`,
        manifest: manifestPath,
        message: role.description,
        agentType: role.type,
      });

      if (result.ok) {
        provisioned.push({ name: role.name, role: role.type });
        if (verbose) {
          process.stderr.write(
            `Provisioned ${role.type} "${role.name}": ${result.value.agentId}\n`,
          );
        }
      } else if (verbose) {
        process.stderr.write(
          `warn: failed to provision ${role.type} "${role.name}": ${result.error.message}\n`,
        );
      }
    }

    return provisioned;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Startup banner
// ---------------------------------------------------------------------------

interface BannerInfo {
  readonly agentName: string;
  readonly presetId: PresetId;
  readonly nexusMode: NexusMode;
  readonly engineName: string;
  readonly modelName: string;
  readonly channels: readonly ChannelAdapter[];
  readonly nexusBaseUrl: string | undefined;
  readonly adminReady: boolean;
  readonly temporalAdmin: { readonly dispose: () => Promise<void> } | undefined;
  readonly temporalUrl: string | undefined;
  readonly provisionedAgents: readonly ProvisionedAgent[];
}

function printBanner(info: BannerInfo): void {
  process.stderr.write("\n");
  process.stderr.write(`Starting Koi ${info.presetId} preset...\n`);

  if (info.nexusBaseUrl !== undefined) {
    const modeLabel = info.nexusMode === "embed-auth" ? "full" : info.nexusMode;
    process.stderr.write(`  \u2713 Nexus ready at ${info.nexusBaseUrl} (${modeLabel})\n`);
  }

  process.stderr.write(
    `  \u2713 Primary agent "${info.agentName}" ready (${info.engineName}, ${info.modelName})\n`,
  );

  for (const agent of info.provisionedAgents) {
    process.stderr.write(`  \u2713 ${agent.role} "${agent.name}" ready\n`);
  }

  if (info.temporalAdmin !== undefined && info.temporalUrl !== undefined) {
    process.stderr.write(`  \u2713 Temporal ready at ${info.temporalUrl}\n`);
  } else if (info.temporalAdmin !== undefined) {
    process.stderr.write("  \u2713 Temporal orchestration connected\n");
  }

  for (const ch of info.channels) {
    process.stderr.write(`  \u2713 Channel "${ch.name}" connected\n`);
  }

  if (info.adminReady) {
    process.stderr.write("  \u2713 Admin API ready at http://localhost:3100/admin/api\n");
    process.stderr.write("  \u2713 Browser admin at http://localhost:3100/admin\n");
  }

  process.stderr.write("\n");
}
