/**
 * `koi up` command — single command to start runtime + admin + TUI.
 *
 * Phases are extracted into individual modules under commands/up/.
 * This orchestrator wires them together with spinners and colored output.
 */

import { dirname, resolve } from "node:path";
import { createCliChannel } from "@koi/channel-cli";
import { createCliOutput, createTimer } from "@koi/cli-render";
import { createContextExtension } from "@koi/context";
import type { ChannelAdapter, EngineInput } from "@koi/core";
import type { AdminPanelBridgeResult, DashboardHandlerResult } from "@koi/dashboard-api";
import { createAdminPanelBridge, createDashboardHandler } from "@koi/dashboard-api";
import type { DashboardEvent } from "@koi/dashboard-types";
import { createPiAdapter } from "@koi/engine-pi";
import { createForgeConfiguredKoi } from "@koi/forge";
import { getEngineName, loadManifest } from "@koi/manifest";
import { resolveRuntimePreset } from "@koi/runtime-presets";
import { EXIT_CONFIG } from "@koi/shutdown";
import { createAgentDispatcher } from "../../agent-dispatcher.js";
import type { AgentChatBridge } from "../../agui-chat-bridge.js";
import type { UpFlags } from "../../args.js";
import { bootstrapForgeOrWarn } from "../../bootstrap-forge.js";
import { createChatRouter } from "../../chat-router.js";
import { collectSubsystemMiddleware, composeRuntimeMiddleware } from "../../compose-middleware.js";
import {
  createLocalFileSystem,
  extractTextFromBlocks,
  persistChatExchangeSafely,
  resolveDashboardAssetsDir,
} from "../../helpers.js";
import { renderEvent } from "../../render-event.js";
import { formatResolutionError, resolveAgent } from "../../resolve-agent.js";
import { resolveAutonomousOrWarn } from "../../resolve-autonomous.js";
import { mergeBootstrapContext } from "../../resolve-bootstrap.js";
import { resolveNexusOrWarn } from "../../resolve-nexus.js";
import { resolveOrchestrationFromAgent } from "../../resolve-orchestration.js";
import { resolveTemporalOrWarn } from "../../resolve-temporal.js";

import { printBanner } from "./banner.js";
import { createInteractiveConsent } from "./consent.js";
import { buildDemoManifestOverrides, provisionDemoAgents, seedDemoPackIfNeeded } from "./demo.js";
import { runDetach } from "./detach.js";
import { mapNexusModeToProfile, startNexusStack, stopNexusStack } from "./nexus.js";
import { runPreflight } from "./preflight.js";
import { extractDemoPack, inferPresetId } from "./preset.js";
import { activatePresetStacks } from "./stacks.js";
import { startTemporalEmbed } from "./temporal.js";

/** Creates a forge view data source from a ForgeStore + optional seeded bricks. */
function createForgeViewSource(
  store: import("@koi/core").ForgeStore,
  seededBricks: readonly import("@koi/dashboard-types").ForgeBrickView[],
  seededForgeEvents: readonly Readonly<Record<string, unknown>>[],
): {
  readonly listBricks: () => Promise<readonly import("@koi/dashboard-types").ForgeBrickView[]>;
  readonly getStats: () => Promise<import("@koi/dashboard-types").ForgeStats>;
  readonly listRecentEvents: () => Promise<
    readonly import("@koi/dashboard-types").ForgeDashboardEvent[]
  >;
} {
  return {
    async listBricks() {
      const result = await store.search({});
      const liveBricks: import("@koi/dashboard-types").ForgeBrickView[] = result.ok
        ? result.value.map((brick) => ({
            brickId: brick.id,
            name: brick.name,
            status: mapLifecycleToStatus(brick.lifecycle),
            fitness: brick.fitness?.successCount
              ? brick.fitness.successCount / (brick.fitness.successCount + brick.fitness.errorCount)
              : 0,
            sampleCount: (brick.fitness?.successCount ?? 0) + (brick.fitness?.errorCount ?? 0),
            createdAt: brick.provenance.metadata.startedAt,
            lastUpdatedAt: brick.fitness?.lastUsedAt ?? brick.provenance.metadata.startedAt,
          }))
        : [];

      if (liveBricks.length > 0) return liveBricks;
      // Fall back to seeded brick data from demo packs
      return seededBricks;
    },
    async getStats() {
      const result = await store.search({});
      const liveBricks = result.ok ? result.value : [];

      if (liveBricks.length > 0) {
        return {
          totalBricks: liveBricks.length,
          activeBricks: liveBricks.filter((b) => b.lifecycle === "active").length,
          demandSignals: 0,
          crystallizeCandidates: 0,
          timestamp: Date.now(),
        };
      }

      // Fall back to seeded brick data
      return {
        totalBricks: seededBricks.length,
        activeBricks: seededBricks.filter((b) => b.status === "active").length,
        demandSignals: seededForgeEvents.filter(
          (e) => (e as Record<string, unknown>).subKind === "demand_detected",
        ).length,
        crystallizeCandidates: seededForgeEvents.filter(
          (e) => (e as Record<string, unknown>).subKind === "crystallize_candidate",
        ).length,
        timestamp: Date.now(),
      };
    },
    async listRecentEvents() {
      // Seeded forge events are typed as ForgeDashboardEvent
      return seededForgeEvents as unknown as import("@koi/dashboard-types").ForgeDashboardEvent[];
    },
  };
}

/** Creates a forge view source backed only by seeded data (no live ForgeStore). */
function createSeededOnlyForgeViewSource(
  seededBricks: readonly import("@koi/dashboard-types").ForgeBrickView[],
  seededForgeEvents: readonly Readonly<Record<string, unknown>>[],
): {
  readonly listBricks: () => Promise<readonly import("@koi/dashboard-types").ForgeBrickView[]>;
  readonly getStats: () => Promise<import("@koi/dashboard-types").ForgeStats>;
  readonly listRecentEvents: () => Promise<
    readonly import("@koi/dashboard-types").ForgeDashboardEvent[]
  >;
} {
  return {
    async listBricks() {
      return seededBricks;
    },
    async getStats() {
      return {
        totalBricks: seededBricks.length,
        activeBricks: seededBricks.filter((b) => b.status === "active").length,
        demandSignals: seededForgeEvents.filter(
          (e) => (e as Record<string, unknown>).subKind === "demand_detected",
        ).length,
        crystallizeCandidates: seededForgeEvents.filter(
          (e) => (e as Record<string, unknown>).subKind === "crystallize_candidate",
        ).length,
        timestamp: Date.now(),
      };
    },
    async listRecentEvents() {
      return seededForgeEvents as unknown as import("@koi/dashboard-types").ForgeDashboardEvent[];
    },
  };
}

function mapLifecycleToStatus(
  lifecycle: string,
): "active" | "deprecated" | "promoted" | "quarantined" {
  switch (lifecycle) {
    case "active":
      return "active";
    case "deprecated":
      return "deprecated";
    case "promoted":
      return "promoted";
    case "quarantined":
      return "quarantined";
    default:
      return "active";
  }
}

/** Captures probeEnv in a closure to avoid L2→L2 import in the bridge. */
function createProbeCallback(
  probeEnv: (
    env: Readonly<Record<string, string | undefined>>,
    patterns: readonly string[],
  ) => readonly { readonly descriptor: import("@koi/core").DataSourceDescriptor }[],
): () => readonly { readonly descriptor: import("@koi/core").DataSourceDescriptor }[] {
  return () =>
    probeEnv(process.env as Readonly<Record<string, string | undefined>>, [
      "*DATABASE_URL*",
      "*_DSN",
      "*_CONNECTION_STRING",
    ]);
}

export async function runUp(flags: UpFlags): Promise<void> {
  // 0. DETACH
  if (flags.detach) {
    const manifestPath = flags.manifest ?? flags.directory ?? "koi.yaml";
    await runDetach(manifestPath);
  }

  const output = createCliOutput({ verbose: flags.verbose, logFormat: flags.logFormat });
  const timer = createTimer(flags.timing);

  // 1. RESOLVE
  const manifestPath = flags.manifest ?? flags.directory ?? "koi.yaml";
  const workspaceRoot = resolve(dirname(manifestPath));

  // 2. VALIDATE
  output.spinner.start("Loading manifest...");
  const loadResult = await timer.time("manifest", () => loadManifest(manifestPath));
  if (!loadResult.ok) {
    output.spinner.stop();
    output.error(
      `Failed to load manifest: ${loadResult.error.message}`,
      "run `koi doctor --repair` to auto-fix common issues",
    );
    process.exit(EXIT_CONFIG);
  }
  const { manifest, warnings } = loadResult.value;
  for (const warning of warnings) output.warn(warning.message);
  output.spinner.stop(undefined);
  output.success("Manifest loaded");

  const engineName = getEngineName(manifest);
  const modelName = manifest.model.name;

  // 3. PRESET
  const presetId = await timer.time("preset", () =>
    Promise.resolve(inferPresetId(manifest as never)),
  );
  const { resolved: preset } = resolveRuntimePreset(presetId);
  const services = preset.services;

  // 4. PREFLIGHT
  // Spinner is stopped before preflight because printPreflightIssues()
  // writes directly to process.stderr and would garble active spinner output.
  const temporalAutoStart = services.temporal === "auto" && flags.temporalUrl === undefined;
  const preflight = await timer.time("preflight", async () =>
    runPreflight({
      manifest,
      env: process.env,
      temporalRequired: temporalAutoStart,
      output,
    }),
  );
  if (!preflight.passed) process.exit(EXIT_CONFIG);
  output.success("Preflight passed");

  output.debug(
    `Preset: ${presetId} (tui=${String(services.tui)}, temporal=${services.temporal}, gateway=${String(services.gateway)})`,
  );

  // 5. FORGE + AUTO-HARNESS
  // Auto-harness needs forgeStore at construction, so we pre-create the store
  // and pass harness outputs into forge bootstrap for full synthesis wiring.
  let currentSessionId = `up:${manifest.name}:0`;
  let sessionCounter = 0;

  // Pre-create auto-harness when preset enables it and forge is enabled
  let autoHarnessOutputs: import("../../bootstrap-forge.js").AutoHarnessOutputs | undefined;
  if (
    preset.stacks.autoHarness === true &&
    (manifest as Record<string, unknown>).forge !== undefined
  ) {
    try {
      const { createInMemoryForgeStore } = await import("@koi/forge");
      const { createAutoHarnessStack } = await import("@koi/auto-harness");
      const preForgeStore = createInMemoryForgeStore();
      const harnessStack = createAutoHarnessStack({
        forgeStore: preForgeStore,
        generate: async () => "",
      });
      autoHarnessOutputs = {
        synthesizeHarness: harnessStack.synthesizeHarness,
        maxSynthesesPerSession: harnessStack.maxSynthesesPerSession,
        policyCacheHandle: harnessStack.policyCacheHandle,
      };
    } catch {
      // Auto-harness is non-fatal
    }
  }

  const forgeResult = await timer.time("forge", () =>
    bootstrapForgeOrWarn(manifest, () => currentSessionId, flags.verbose, autoHarnessOutputs),
  );
  const forgeBootstrap = forgeResult?.bootstrap;
  const sandboxBridge = forgeResult?.sandboxBridge;

  const { createAgentChatBridge } = await import("../../agui-chat-bridge.js");
  const chatBridge: AgentChatBridge = createAgentChatBridge();

  // 6. RESOLVE agent + subsystems
  output.spinner.start("Resolving agent...");
  const resolved = await timer.time("resolve", () =>
    resolveAgent({
      manifestPath,
      manifest,
      ...(forgeBootstrap !== undefined ? { forgeStore: forgeBootstrap.store } : {}),
    }),
  );
  if (!resolved.ok) {
    output.spinner.stop();
    output.error(formatResolutionError(resolved.error));
    if (sandboxBridge !== undefined) await sandboxBridge.dispose();
    process.exit(EXIT_CONFIG);
  }
  output.spinner.stop(undefined);
  output.success("Agent resolved");

  const adapter = resolved.value.engine ?? createPiAdapter({ model: modelName });

  // Nexus auto-start (embed-auth)
  let nexusBaseUrl = flags.nexusUrl ?? manifest.nexus?.url ?? process.env.NEXUS_URL;
  let nexusStartedByUs = false;
  if (nexusBaseUrl === undefined && preset.nexusMode === "embed-auth") {
    output.spinner.start("Starting Nexus...");
    const nexusResult = await timer.time("nexus-up", () =>
      startNexusStack(workspaceRoot, presetId, flags.verbose),
    );
    if (nexusResult !== undefined) {
      nexusBaseUrl = nexusResult.baseUrl;
      nexusStartedByUs = true;
      if (nexusResult.apiKey !== undefined && process.env.NEXUS_API_KEY === undefined) {
        process.env.NEXUS_API_KEY = nexusResult.apiKey;
      }
    }
    output.spinner.stop(undefined);
  }

  // Temporal auto-start
  let temporalEmbedHandle: Awaited<ReturnType<typeof startTemporalEmbed>>;
  let temporalUrl = flags.temporalUrl;
  if (temporalAutoStart) {
    output.spinner.start("Starting Temporal...");
    temporalEmbedHandle = await timer.time("temporal-embed", () =>
      startTemporalEmbed(flags.verbose),
    );
    if (temporalEmbedHandle !== undefined) temporalUrl = temporalEmbedHandle.url;
    output.spinner.stop(undefined);
  }

  const embedProfile = nexusStartedByUs ? undefined : mapNexusModeToProfile(preset.nexusMode);

  // Resolve subsystems in parallel
  output.spinner.start("Resolving subsystems...");
  const [nexus, autonomous, temporalAdmin] = await timer.time("subsystems", () =>
    Promise.all([
      resolveNexusOrWarn(nexusBaseUrl, manifest.nexus?.url, flags.verbose, embedProfile),
      resolveAutonomousOrWarn(manifest, flags.verbose),
      temporalUrl !== undefined
        ? resolveTemporalOrWarn(temporalUrl, flags.verbose)
        : Promise.resolve(undefined),
    ]),
  );
  output.spinner.stop(undefined);
  output.success("Subsystems resolved");

  // 7. ASSEMBLE
  output.spinner.start("Assembling runtime...");
  const contextConfig = await mergeBootstrapContext(manifest.context, manifestPath, manifest.name);
  const contextExt = createContextExtension(contextConfig);
  const extensions = contextExt !== undefined ? [contextExt] : [];

  // Data source auto-discovery (non-fatal)
  let dataSourceProvider: import("@koi/core").ComponentProvider | undefined;
  let dataSourceTools: readonly import("@koi/core").Tool[] = [];
  let discoveredSourceNames: readonly { readonly name: string; readonly protocol: string }[] = [];
  let discoveredSourceSummaries:
    | readonly import("@koi/dashboard-types").DataSourceSummary[]
    | undefined;
  let discoveredDescriptors: readonly import("@koi/core").DataSourceDescriptor[] | undefined;
  let dataSourceExecutorFn:
    | ((
        source: import("@koi/core").DataSourceDescriptor,
        query: unknown,
        credential: string | undefined,
      ) => Promise<{ readonly ok: boolean; readonly data?: unknown; readonly error?: string }>)
    | undefined;
  let probeEnvFn:
    | ((
        env: Readonly<Record<string, string | undefined>>,
        patterns: readonly string[],
      ) => readonly { readonly descriptor: import("@koi/core").DataSourceDescriptor }[])
    | undefined;
  try {
    const { createDataSourceStack } = await import("@koi/data-source-stack");
    const manifestEntries = (manifest as unknown as Record<string, unknown>).dataSources as
      | readonly import("@koi/data-source-stack").ManifestDataSourceEntry[]
      | undefined;
    const dsStack = await createDataSourceStack({
      manifestEntries,
      env: process.env,
      consent: createInteractiveConsent(output),
    });
    if (dsStack.discoveredSources.length === 0) {
      output.info("No data sources found — add MCP servers to koi.yaml or set credentials in .env");
    } else {
      dataSourceProvider = dsStack.provider;
      dataSourceTools = dsStack.tools;
      discoveredSourceNames = dsStack.discoveredSources.map((s) => ({
        name: s.name,
        protocol: s.protocol,
      }));
      // Build summaries for the dashboard bridge
      const manifestNames = new Set((manifestEntries ?? []).map((e) => e.name));
      discoveredSourceSummaries = dsStack.discoveredSources.map((s) => ({
        name: s.name,
        protocol: s.protocol,
        status: "approved" as const,
        source: manifestNames.has(s.name)
          ? ("manifest" as const)
          : s.mcpToolName !== undefined
            ? ("mcp" as const)
            : ("env" as const),
      }));
      discoveredDescriptors = dsStack.discoveredSources;

      // Print credential fallback guidance for sources needing auth
      for (const source of dsStack.discoveredSources) {
        if (source.auth?.ref !== undefined && process.env[source.auth.ref] === undefined) {
          output.warn(
            `Source "${source.name}" needs credential — set ${source.auth.ref} in your environment`,
          );
        }
      }
    }
    // Capture executor for schema probing in dashboard bridge
    const { executeDataSourceQuery } = await import("@koi/data-source-stack");
    dataSourceExecutorFn = executeDataSourceQuery;
    // Capture probeEnv for rescan callback (avoids L2→L2 import in bridge)
    const { probeEnv } = await import("@koi/data-source-discovery");
    probeEnvFn = probeEnv;
  } catch {
    // Data source discovery is non-fatal
  }

  // Activate L3 stacks based on preset flags
  const activatedStacks = await activatePresetStacks({
    stacks: preset.stacks,
    forgeBootstrap:
      forgeBootstrap !== undefined
        ? { store: forgeBootstrap.store, runtime: forgeBootstrap.runtime }
        : undefined,
    verbose: flags.verbose,
  });

  const composed = composeRuntimeMiddleware({
    resolved: resolved.value.middleware,
    nexus,
    forge: forgeBootstrap,
    autonomous,
    chatBridge,
    dataSourceProvider,
    dataSourceTools,
    presetMiddleware: activatedStacks.middleware,
    presetProviders: activatedStacks.providers,
  });

  // Late-binding event sink for forge/monitor SSE events
  // let justified: mutable ref set when adminBridge is created
  let emitDashboardEvent: ((event: DashboardEvent) => void) | undefined;

  const { runtime } = await timer.time("runtime", () =>
    createForgeConfiguredKoi({
      manifest,
      adapter,
      middleware: composed.middleware,
      providers: composed.providers,
      extensions,
      ...(forgeBootstrap !== undefined ? { forge: forgeBootstrap.runtime } : {}),
      onDashboardEvent: (event: DashboardEvent) => {
        emitDashboardEvent?.(event);
      },
    }),
  );
  output.spinner.stop(undefined);
  output.success("Runtime assembled");

  // 8. Connect channels (parallel)
  const channels: readonly ChannelAdapter[] = resolved.value.channels ?? [createCliChannel()];
  await Promise.all(channels.map((ch) => ch.connect()));

  // 8b. Gateway + Node (conditional on preset services)
  let stopGateway: (() => Promise<void>) | undefined;
  let stopNode: (() => Promise<void>) | undefined;

  if (services.gateway) {
    try {
      const { createGatewayStack } = await import("@koi/gateway-stack");
      const { createBunTransport } = await import("@koi/gateway");
      const transport = createBunTransport();
      const auth = {
        authenticate: async () => ({
          ok: true as const,
          session: { id: "local", agentId: manifest.name },
        }),
        validate: async () => true,
      };
      const nexusConfig =
        nexusBaseUrl !== undefined
          ? { nexusUrl: nexusBaseUrl, apiKey: process.env.NEXUS_API_KEY ?? "" }
          : undefined;
      const gwStack = createGatewayStack(
        { ...(nexusConfig !== undefined ? { nexus: nexusConfig } : {}) },
        { transport, auth },
      );
      const DEFAULT_GATEWAY_PORT = 4100;
      await gwStack.start(DEFAULT_GATEWAY_PORT);
      stopGateway = () => gwStack.stop();
      output.success(`Gateway started on port ${String(DEFAULT_GATEWAY_PORT)}`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      output.warn(`gateway failed to start: ${message}`);
    }
  }

  if (services.node !== "disabled") {
    try {
      const { createNodeStack } = await import("@koi/node-stack");
      const nodeStack = createNodeStack({ node: {} }, {});
      await nodeStack.start();
      stopNode = () => nodeStack.stop();
      output.success("Node started");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      output.warn(`node failed to start: ${message}`);
    }
  }

  // 8b. Demo pack seed (before admin so seeded bricks are available for forge view)
  const demoPack = await extractDemoPack(manifestPath);
  let demoNexusClient: import("@koi/nexus-client").NexusClient | undefined;
  if (demoPack !== undefined && nexus.baseUrl !== undefined) {
    const { createNexusClient } = await import("@koi/nexus-client");
    const apiKey = process.env.NEXUS_API_KEY;
    demoNexusClient = createNexusClient({
      baseUrl: nexus.baseUrl,
      ...(apiKey !== undefined ? { apiKey } : {}),
    });
  }
  const seedResult = await seedDemoPackIfNeeded(
    demoPack,
    workspaceRoot,
    manifest.name,
    demoNexusClient,
    flags.verbose,
  );

  // 9. ADMIN
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

    const subsystem = collectSubsystemMiddleware({
      nexus,
      forge: forgeBootstrap,
      autonomous,
    });

    // Build per-role manifest overrides for demo agents
    const demoOverrides = await buildDemoManifestOverrides(manifest as never);

    const dispatcher = createAgentDispatcher({
      defaultManifestPath: manifestPath,
      verbose: flags.verbose,
      additionalMiddleware: subsystem.middleware,
      additionalProviders: subsystem.providers,
      additionalExtensions: extensions,
      ...(forgeBootstrap !== undefined
        ? { forgeStore: forgeBootstrap.store, forgeRuntime: forgeBootstrap.runtime }
        : {}),
      ...(demoOverrides !== undefined ? { manifestOverrides: demoOverrides } : {}),
      onDashboardEvent: (event) => {
        emitDashboardEvent?.(event as DashboardEvent);
      },
    });
    adminDispatcher = dispatcher;

    adminBridge = createAdminPanelBridge({
      agentName: manifest.name,
      agentType: manifest.lifecycle ?? "copilot",
      model: modelName,
      channels: channelNames,
      skills: skillNames,
      fileSystem: createLocalFileSystem(workspaceRoot),
      discoveredSources: discoveredSourceSummaries,
      dataSourceDescriptors: discoveredDescriptors,
      ...(dataSourceExecutorFn !== undefined ? { dataSourceExecutor: dataSourceExecutorFn } : {}),
      ...(probeEnvFn !== undefined
        ? {
            probeEnvForSources: createProbeCallback(probeEnvFn),
          }
        : {}),
      dispatchAgent: dispatcher.dispatchAgent,
      onTerminateAgent: async (id) => {
        await dispatcher.terminateAgent(id);
      },
      ...(orch.hasAny
        ? { orchestration: orch.orchestration, orchestrationCommands: orch.orchestrationCommands }
        : {}),
      ...(forgeBootstrap !== undefined
        ? {
            forge: createForgeViewSource(
              forgeBootstrap.store,
              seedResult.seededBricks,
              seedResult.seededForgeEvents,
            ),
          }
        : seedResult.seededBricks.length > 0
          ? {
              forge: createSeededOnlyForgeViewSource(
                seedResult.seededBricks,
                seedResult.seededForgeEvents,
              ),
            }
          : {}),
    });

    // Wire forge/monitor SSE event sink now that the bridge exists
    emitDashboardEvent = adminBridge.emitEvent;

    const routingChatHandler = createChatRouter({
      primaryHandler: chatBridge.handler,
      getDispatchedHandler: dispatcher.getChatHandler,
      isPrimaryAgent: (id) => id === adminBridge?.agentId,
    });

    const assetsDir = resolveDashboardAssetsDir();
    const dashboardResult: DashboardHandlerResult = createDashboardHandler(
      { ...adminBridge, agentChatHandler: routingChatHandler },
      { cors: true, ...(assetsDir !== undefined ? { assetsDir } : {}) },
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
    output.warn(`admin panel failed to start: ${message}`);
    adminBridge = undefined;
  }

  const persistAgentId = adminBridge?.agentId ?? manifest.name;

  // 9b. Demo agent provisioning
  const provisionedAgents = await provisionDemoAgents(
    demoPack,
    manifestPath,
    adminDispatcher,
    flags.verbose,
  );

  // 10. Health server
  const DEFAULT_HEALTH_PORT = 9100;
  let stopHealth: (() => void) | undefined;
  try {
    const { createHealthServer } = await import("@koi/deploy");
    const healthServer = createHealthServer({
      port: manifest.deploy?.port ?? DEFAULT_HEALTH_PORT,
      onReady: () => true,
    });
    const healthInfo = await healthServer.start();
    stopHealth = () => healthServer.stop();
    output.debug(`Health server: ${healthInfo.url}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    output.warn(`health server failed to start: ${message}`);
  }

  // 11. BANNER
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
    discoveredSources: discoveredSourceNames,
    prompts: seedResult.prompts,
  });

  // 12. TUI
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
    output.info("Operator console attached.\n");
  } else {
    output.info("Type a message or Ctrl+C to stop.\n");
  }

  // 13. REPL + shutdown
  const controller = new AbortController();
  let shuttingDown = false;

  function shutdown(): void {
    if (shuttingDown) {
      process.stderr.write("\nForce exit.\n");
      process.exit(1);
    }
    shuttingDown = true;
    output.info("\nShutting down...");
    controller.abort();
  }

  process.on("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  let processing = false;

  chatBridge.wireDispatch(async (msg) => {
    if (processing) throw new Error("Agent is busy processing another request");
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
          adminBridge.updateMetrics({
            turns: event.output.metrics.turns,
            totalTokens: event.output.metrics.totalTokens,
          });
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
        output.warn("still processing previous message, please wait");
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
          renderEvent(event, { verbose: flags.verbose });
          if (event.kind === "text_delta") deltas.push(event.delta);
          if (event.kind === "done" && adminBridge !== undefined) {
            adminBridge.updateMetrics({
              turns: event.output.metrics.turns,
              totalTokens: event.output.metrics.totalTokens,
            });
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
          output.error(message);
        }
      } finally {
        processing = false;
      }
    }),
  );

  await new Promise<void>((r) => {
    controller.signal.addEventListener("abort", () => r(), { once: true });
  });

  // Cleanup
  process.removeListener("SIGINT", shutdown);
  process.removeListener("SIGTERM", shutdown);
  if (tuiApp !== undefined) await tuiApp.stop();
  for (const unsub of unsubscribers) unsub();
  for (const ch of channels) await ch.disconnect();
  if (stopHealth !== undefined) stopHealth();
  if (stopAdmin !== undefined) stopAdmin();
  if (adminDispatcher !== undefined) await adminDispatcher.dispose();
  if (temporalAdmin !== undefined) await temporalAdmin.dispose();
  if (temporalEmbedHandle !== undefined) await temporalEmbedHandle.dispose();
  await runtime.dispose();
  for (const dispose of activatedStacks.disposables) await dispose();
  if (stopNode !== undefined) await stopNode();
  if (stopGateway !== undefined) await stopGateway();
  if (autonomous !== undefined) await autonomous.dispose();
  forgeBootstrap?.dispose();
  if (sandboxBridge !== undefined) await sandboxBridge.dispose();
  if (nexus.dispose !== undefined) await nexus.dispose();
  if (nexusStartedByUs) await stopNexusStack(workspaceRoot, flags.verbose);

  output.info("Goodbye.");
}
