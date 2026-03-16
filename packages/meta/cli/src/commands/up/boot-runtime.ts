/**
 * Boot runtime — shared startup logic for both `koi up` and TUI welcome flow.
 *
 * Extracts the core service startup (forge bootstrap, agent resolution,
 * runtime assembly, channel connection, admin panel) from runUp() so it
 * can be called in-process from startStack() without spawning a subprocess.
 *
 * Does NOT enter a REPL loop or attach a TUI — the caller manages those.
 */

import { dirname, resolve } from "node:path";
import { createCliChannel } from "@koi/channel-cli";
import type { ChannelAdapter, EngineInput } from "@koi/core";
import type { AdminPanelBridgeResult, DashboardHandlerResult } from "@koi/dashboard-api";
import { createAdminPanelBridge, createDashboardHandler } from "@koi/dashboard-api";
import type { DashboardEvent } from "@koi/dashboard-types";
import { createPiAdapter } from "@koi/engine-pi";
import { createForgeConfiguredKoi } from "@koi/forge";
import { loadManifest } from "@koi/manifest";
import { resolveRuntimePreset } from "@koi/runtime-presets";
import { createAgentDispatcher } from "../../agent-dispatcher.js";
import type { AgentChatBridge } from "../../agui-chat-bridge.js";
import { bootstrapForgeOrWarn } from "../../bootstrap-forge.js";
import { createChatRouter } from "../../chat-router.js";
import { collectSubsystemMiddleware, composeRuntimeMiddleware } from "../../compose-middleware.js";
import {
  createLocalFileSystem,
  extractTextFromBlocks,
  persistChatExchangeSafely,
  resolveDashboardAssetsDir,
} from "../../helpers.js";
import { resolveAgent } from "../../resolve-agent.js";
import { resolveAutonomousOrWarn } from "../../resolve-autonomous.js";
import { resolveNexusOrWarn } from "../../resolve-nexus.js";
import { resolveOrchestrationFromAgent } from "../../resolve-orchestration.js";
import { buildDemoManifestOverrides, provisionDemoAgents, seedDemoPackIfNeeded } from "./demo.js";
import { mapNexusModeToProfile } from "./nexus.js";
import { extractDemoPack, inferPresetId } from "./preset.js";
import { activatePresetStacks } from "./stacks.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Handle returned from bootRuntime for lifecycle management. */
export interface RuntimeHandle {
  /** The admin API URL (e.g., "http://localhost:3100/admin/api"). */
  readonly adminUrl: string;
  /** Dispose all services (admin, channels, runtime, forge, etc.). */
  readonly dispose: () => Promise<void>;
}

export interface BootRuntimeOptions {
  /** Path to koi.yaml. */
  readonly manifestPath: string;
  /** Workspace root directory (defaults to dirname of manifestPath). */
  readonly workspaceRoot?: string | undefined;
  /** Emit verbose diagnostics to stderr. */
  readonly verbose: boolean;
  /** Admin panel HTTP port (default: 3100). */
  readonly adminPort?: number | undefined;
  /** Progress callback for phase reporting. */
  readonly onProgress?: ((phase: string, message: string) => void) | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Boot the Koi runtime in-process.
 *
 * Runs forge bootstrap, agent resolution, runtime assembly, channel
 * connection, and admin panel startup. Returns a handle for cleanup.
 */
export async function bootRuntime(options: BootRuntimeOptions): Promise<RuntimeHandle> {
  const { manifestPath, verbose, adminPort = 3100, onProgress } = options;
  const workspaceRoot = options.workspaceRoot ?? resolve(dirname(manifestPath));

  const progress = (phase: string, msg: string): void => {
    onProgress?.(phase, msg);
  };

  // ------------------------------------------------------------------
  // 1. Load manifest
  // ------------------------------------------------------------------
  progress("manifest", "Loading manifest");
  const loadResult = await loadManifest(manifestPath);
  if (!loadResult.ok) {
    throw new Error(`Failed to load manifest: ${loadResult.error.message}`);
  }
  const { manifest } = loadResult.value;
  const modelName = manifest.model.name;

  // ------------------------------------------------------------------
  // 2. Resolve preset
  // ------------------------------------------------------------------
  progress("preset", "Resolving preset");
  const presetId = await inferPresetId(manifestPath);
  const { resolved: preset } = resolveRuntimePreset(presetId);

  // ------------------------------------------------------------------
  // 3. Resolve Nexus + autonomous (before forge, so search backends are available)
  // ------------------------------------------------------------------
  const nexusBaseUrl = manifest.nexus?.url ?? process.env.NEXUS_URL;
  const embedProfile = mapNexusModeToProfile(preset.nexusMode);

  progress("subsystems", "Resolving subsystems");
  const [nexus, autonomous] = await Promise.all([
    resolveNexusOrWarn(nexusBaseUrl, manifest.nexus?.url, verbose, embedProfile, undefined),
    resolveAutonomousOrWarn(manifest, verbose),
  ]);

  // ------------------------------------------------------------------
  // 4. Forge bootstrap (non-fatal)
  // ------------------------------------------------------------------
  progress("forge", "Bootstrapping forge");
  const currentSessionId = `up:${manifest.name}:0`;

  const forgeResult = await bootstrapForgeOrWarn(
    manifest,
    () => currentSessionId,
    verbose,
    undefined,
    nexus.search,
  );
  const forgeBootstrap = forgeResult?.bootstrap;
  const sandboxBridge = forgeResult?.sandboxBridge;

  // ------------------------------------------------------------------
  // 5. AG-UI chat bridge
  // ------------------------------------------------------------------
  const { createAgentChatBridge } = await import("../../agui-chat-bridge.js");
  const chatBridge: AgentChatBridge = createAgentChatBridge();

  // ------------------------------------------------------------------
  // 6. Resolve agent
  // ------------------------------------------------------------------
  progress("resolve", "Resolving agent");
  const resolved = await resolveAgent({
    manifestPath,
    manifest,
    ...(forgeBootstrap !== undefined ? { forgeStore: forgeBootstrap.store } : {}),
  });
  if (!resolved.ok) {
    if (sandboxBridge !== undefined) await sandboxBridge.dispose();
    if (autonomous !== undefined) await autonomous.dispose();
    if (nexus.dispose !== undefined) await nexus.dispose();
    throw new Error(`Agent resolution failed: ${resolved.error.message}`);
  }

  const adapter = resolved.value.engine ?? createPiAdapter({ model: modelName });

  // ------------------------------------------------------------------
  // 7. Activate preset stacks + compose middleware
  // ------------------------------------------------------------------
  progress("stacks", "Activating preset stacks");
  const activatedStacks = await activatePresetStacks({
    stacks: preset.stacks,
    forgeBootstrap:
      forgeBootstrap !== undefined
        ? { store: forgeBootstrap.store, runtime: forgeBootstrap.runtime }
        : undefined,
    verbose,
  });

  const composed = composeRuntimeMiddleware({
    resolved: resolved.value.middleware,
    nexus,
    forge: forgeBootstrap,
    autonomous,
    chatBridge,
    dataSourceProvider: undefined,
    dataSourceTools: [],
    presetMiddleware: activatedStacks.middleware,
    presetProviders: activatedStacks.providers,
  });

  // Late-binding event sink for forge/monitor SSE events
  // let justified: mutable ref set when adminBridge is created
  let emitDashboardEvent: ((event: DashboardEvent) => void) | undefined;

  // ------------------------------------------------------------------
  // 8. Assemble runtime
  // ------------------------------------------------------------------
  progress("assemble", "Assembling runtime");
  const { runtime, dispose: forgeSystemDispose } = await createForgeConfiguredKoi({
    manifest,
    adapter,
    middleware: composed.middleware,
    providers: composed.providers,
    extensions: [],
    ...(forgeBootstrap !== undefined ? { forge: forgeBootstrap.runtime } : {}),
    onDashboardEvent: (event: DashboardEvent) => {
      emitDashboardEvent?.(event);
    },
  });

  // ------------------------------------------------------------------
  // 9. Connect channels
  // ------------------------------------------------------------------
  progress("channels", "Connecting channels");
  const channels: readonly ChannelAdapter[] = resolved.value.channels ?? [createCliChannel()];
  await Promise.all(channels.map((ch) => ch.connect()));

  // ------------------------------------------------------------------
  // 10. Demo seed
  // ------------------------------------------------------------------
  progress("demo", "Seeding demo data");
  const demoPack = await extractDemoPack(manifestPath);
  // Build a Nexus client for seeding if Nexus is available
  let demoNexusClient: import("@koi/nexus-client").NexusClient | undefined;
  if (demoPack !== undefined && nexus.baseUrl !== undefined) {
    try {
      const { createNexusClient } = await import("@koi/nexus-client");
      const apiKey = process.env.NEXUS_API_KEY;
      demoNexusClient = createNexusClient({
        baseUrl: nexus.baseUrl,
        ...(apiKey !== undefined ? { apiKey } : {}),
      });
    } catch {
      // Nexus client creation is non-fatal for demo seeding
    }
  }
  await seedDemoPackIfNeeded(demoPack, workspaceRoot, manifest.name, demoNexusClient, verbose);

  // ------------------------------------------------------------------
  // 11. Admin panel
  // ------------------------------------------------------------------
  progress("admin", `Starting admin panel on port ${String(adminPort)}`);
  const channelNames = channels.map((ch) => ch.name);
  const skillNames = (manifest.skills ?? []).map((s) => s.name);
  const orch = resolveOrchestrationFromAgent({
    agent: runtime.agent,
    ...(autonomous !== undefined ? { harness: autonomous.harness } : {}),
    verbose,
  });

  const subsystem = collectSubsystemMiddleware({
    nexus,
    forge: forgeBootstrap,
    autonomous,
  });

  const demoOverrides = await buildDemoManifestOverrides(manifest.name, demoPack);

  const dispatcher = createAgentDispatcher({
    defaultManifestPath: manifestPath,
    verbose,
    additionalMiddleware: subsystem.middleware,
    additionalProviders: subsystem.providers,
    additionalExtensions: [],
    ...(forgeBootstrap !== undefined
      ? { forgeStore: forgeBootstrap.store, forgeRuntime: forgeBootstrap.runtime }
      : {}),
    ...(demoOverrides !== undefined ? { manifestOverrides: demoOverrides } : {}),
    onDashboardEvent: (event) => {
      emitDashboardEvent?.(event as DashboardEvent);
    },
  });

  const adminBridge: AdminPanelBridgeResult = createAdminPanelBridge({
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
      ? { orchestration: orch.orchestration, orchestrationCommands: orch.orchestrationCommands }
      : {}),
  });

  // Wire forge/monitor SSE event sink now that the bridge exists
  emitDashboardEvent = adminBridge.emitEvent;

  const routingChatHandler = createChatRouter({
    primaryHandler: chatBridge.handler,
    getDispatchedHandler: dispatcher.getChatHandler,
    isPrimaryAgent: (id) => id === adminBridge.agentId,
  });

  const assetsDir = resolveDashboardAssetsDir();
  const dashboardResult: DashboardHandlerResult = createDashboardHandler(
    { ...adminBridge, agentChatHandler: routingChatHandler },
    { cors: true, ...(assetsDir !== undefined ? { assetsDir } : {}) },
  );

  const server = Bun.serve({
    port: adminPort,
    idleTimeout: 255,
    async fetch(req: Request): Promise<Response> {
      const adminResponse = await dashboardResult.handler(req);
      if (adminResponse !== null) return adminResponse;
      return new Response("Not Found", { status: 404 });
    },
  });

  // ------------------------------------------------------------------
  // 12. Provision demo agents
  // ------------------------------------------------------------------
  await provisionDemoAgents(demoPack, manifestPath, dispatcher, verbose);

  // ------------------------------------------------------------------
  // 13. Wire chat dispatch
  // ------------------------------------------------------------------
  const persistAgentId = adminBridge.agentId ?? manifest.name;

  // Concurrency guard for single-flight runtime.run()
  // let justified: guards against concurrent AG-UI chat + channel messages
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
      const input: EngineInput = { kind: "messages", messages: [msg] };
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

  progress("ready", "Runtime is ready");

  const adminUrl = `http://localhost:${String(adminPort)}/admin/api`;

  // ------------------------------------------------------------------
  // Dispose — tear down everything in reverse order
  // ------------------------------------------------------------------
  const dispose = async (): Promise<void> => {
    for (const ch of channels) await ch.disconnect();
    server.stop(true);
    dashboardResult.dispose();
    await dispatcher.dispose();
    await runtime.dispose();
    forgeSystemDispose();
    for (const d of activatedStacks.disposables) await d();
    if (autonomous !== undefined) await autonomous.dispose();
    forgeBootstrap?.dispose();
    if (sandboxBridge !== undefined) await sandboxBridge.dispose();
    if (nexus.dispose !== undefined) await nexus.dispose();
  };

  return { adminUrl, dispose };
}
