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
import { composeRuntimeMiddleware } from "../../compose-middleware.js";
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
import { provisionDemoAgents, seedDemoPackIfNeeded } from "./demo.js";
import { runDetach } from "./detach.js";
import { mapNexusModeToProfile, startNexusStack, stopNexusStack } from "./nexus.js";
import { runPreflight } from "./preflight.js";
import { inferPresetId } from "./preset.js";
import { startTemporalEmbed } from "./temporal.js";

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
  const presetId = await timer.time("preset", () => inferPresetId(manifestPath));
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

  // 5. FORGE
  let currentSessionId = `up:${manifest.name}:0`;
  let sessionCounter = 0;
  const forgeResult = await timer.time("forge", () =>
    bootstrapForgeOrWarn(manifest, () => currentSessionId, flags.verbose),
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
    if (dsStack.discoveredSources.length > 0) {
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
    }
  } catch {
    // Data source discovery is non-fatal
  }

  const composed = composeRuntimeMiddleware({
    resolved: resolved.value.middleware,
    nexus,
    forge: forgeBootstrap,
    autonomous,
    chatBridge,
    dataSourceProvider,
    dataSourceTools,
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
  output.spinner.stop(undefined);
  output.success("Runtime assembled");

  // 8. Connect channels
  const channels: readonly ChannelAdapter[] = resolved.value.channels ?? [createCliChannel()];
  for (const ch of channels) await ch.connect();

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
      discoveredSources: discoveredSourceSummaries,
      dataSourceDescriptors: discoveredDescriptors,
      dispatchAgent: dispatcher.dispatchAgent,
      onTerminateAgent: async (id) => {
        await dispatcher.terminateAgent(id);
      },
      ...(orch.hasAny
        ? { orchestration: orch.orchestration, orchestrationCommands: orch.orchestrationCommands }
        : {}),
    });

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

  // 9b. Demo pack
  await seedDemoPackIfNeeded(
    manifestPath,
    workspaceRoot,
    manifest.name,
    nexus.baseUrl,
    flags.verbose,
  );
  const provisionedAgents = await provisionDemoAgents(manifestPath, adminDispatcher, flags.verbose);

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
  if (autonomous !== undefined) await autonomous.dispose();
  forgeBootstrap?.dispose();
  if (sandboxBridge !== undefined) await sandboxBridge.dispose();
  if (nexus.dispose !== undefined) await nexus.dispose();
  if (nexusStartedByUs) await stopNexusStack(workspaceRoot, flags.verbose);

  output.info("Goodbye.");
}
