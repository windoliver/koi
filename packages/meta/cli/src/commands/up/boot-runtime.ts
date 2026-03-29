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
import type { ChannelAdapter, EngineInput, InboundMessage } from "@koi/core";
import type { AdminPanelBridgeResult, DashboardHandlerResult } from "@koi/dashboard-api";
import { createAdminPanelBridge, createDashboardHandler } from "@koi/dashboard-api";
import type { AgentCostEntry, CostSnapshot, DashboardEvent } from "@koi/dashboard-types";
import { createPiAdapter } from "@koi/engine-pi";
import { createForgeConfiguredKoi } from "@koi/forge";
import { loadManifest } from "@koi/manifest";
import { createDefaultCostCalculator } from "@koi/middleware-pay";
import { resolveRuntimePreset } from "@koi/runtime-presets";
import { createAgentDispatcher } from "../../agent-dispatcher.js";
import type { AgentChatBridge } from "../../agui-chat-bridge.js";
import { bootstrapForgeOrWarn } from "../../bootstrap-forge.js";
import { createChatRouter } from "../../chat-router.js";
import { collectSubsystemMiddleware, composeRuntimeMiddleware } from "../../compose-middleware.js";
import type { RuntimeContributionGraph } from "../../contribution-graph.js";
import { addPostCompositionContributions } from "../../contribution-graph.js";
import { buildDebugExtraItems, collectActiveSubsystems } from "../../debug-inventory-items.js";
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
// Helpers
// ---------------------------------------------------------------------------

const LABEL_RE = /^\[(user|assistant|system)\]:\s*/;

/**
 * Expand stateless-normalized content blocks into separate InboundMessages.
 *
 * The AG-UI stateless normalizer flattens conversation history into labeled
 * blocks like `[user]: hello`, `[assistant]: Hi!`. This function splits them
 * back into individual InboundMessages so the engine adapter can send proper
 * multi-turn messages to the model API.
 */
function expandLabeledBlocks(msg: InboundMessage): readonly InboundMessage[] {
  const blocks = msg.content.filter(
    (b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text",
  );

  // If no blocks match the labeled pattern, return the message as-is.
  if (blocks.length === 0 || !LABEL_RE.test(blocks[0]?.text ?? "")) {
    return [msg];
  }

  return blocks.map((block) => {
    const match = LABEL_RE.exec(block.text);
    const role = match?.[1] ?? "user";
    const text = block.text.replace(LABEL_RE, "");
    return {
      content: [{ kind: "text" as const, text }],
      senderId: role === "user" ? (msg.senderId ?? msg.threadId) : "assistant",
      ...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
      timestamp: msg.timestamp,
      metadata: { ...msg.metadata, role },
    };
  });
}

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
  /** Base URL of a running Nexus instance (set by the nexus phase in start-stack). */
  readonly nexusBaseUrl?: string | undefined;
  /** Cleanup callback for Nexus shutdown (if we started it). */
  readonly nexusCleanup?: (() => Promise<void>) | undefined;
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
  // 3. Forge bootstrap (non-fatal)
  // ------------------------------------------------------------------
  progress("forge", "Bootstrapping forge");
  const currentSessionId = `up:${manifest.name}:0`;

  const forgeResolution = await bootstrapForgeOrWarn(
    manifest,
    () => currentSessionId,
    verbose,
    undefined,
  );
  const forgeBootstrap = forgeResolution.result?.bootstrap;
  const sandboxBridge = forgeResolution.result?.sandboxBridge;

  // ------------------------------------------------------------------
  // 4. AG-UI chat bridge
  // ------------------------------------------------------------------
  const { createAgentChatBridge } = await import("../../agui-chat-bridge.js");
  const chatBridge: AgentChatBridge = createAgentChatBridge();

  // ------------------------------------------------------------------
  // 5. Resolve agent + subsystems
  // ------------------------------------------------------------------
  progress("resolve", "Resolving agent");
  const resolved = await resolveAgent({
    manifestPath,
    manifest,
    ...(forgeBootstrap !== undefined ? { forgeStore: forgeBootstrap.store } : {}),
  });
  if (!resolved.ok) {
    // Clean up forge on failure
    if (sandboxBridge !== undefined) await sandboxBridge.dispose();
    throw new Error(`Agent resolution failed: ${resolved.error.message}`);
  }

  const adapter = resolved.value.engine ?? createPiAdapter({ model: modelName });

  const nexusBaseUrl = options.nexusBaseUrl ?? manifest.nexus?.url ?? process.env.NEXUS_URL;
  const embedProfile = mapNexusModeToProfile(preset.nexusMode);

  progress("subsystems", "Resolving subsystems");
  const [nexusResolution, autonomousResolution] = await Promise.all([
    resolveNexusOrWarn(nexusBaseUrl, manifest.nexus?.url, verbose, embedProfile, undefined),
    resolveAutonomousOrWarn(manifest, verbose),
  ]);
  const nexus = nexusResolution.state;
  const autonomous = autonomousResolution.result;

  // ------------------------------------------------------------------
  // 6. Activate preset stacks + compose middleware
  // ------------------------------------------------------------------
  progress("stacks", "Activating preset stacks");
  // Auto-enable sandboxStack when the manifest declares a sandbox config,
  // so operators don't need a preset that explicitly sets sandboxStack: true.
  const effectiveStacks =
    manifest.codeSandbox !== undefined
      ? { ...preset.stacks, sandboxStack: true as const }
      : preset.stacks;

  const activatedStacks = await activatePresetStacks({
    stacks: effectiveStacks,
    forgeBootstrap:
      forgeBootstrap !== undefined
        ? { store: forgeBootstrap.store, runtime: forgeBootstrap.runtime }
        : undefined,
    verbose,
    ...(manifest.codeSandbox !== undefined ? { sandboxConfig: manifest.codeSandbox } : {}),
  });

  // ------------------------------------------------------------------
  // 6b. Cost tracking — reads from engine metrics on each turn
  // ------------------------------------------------------------------
  const SESSION_BUDGET = 2.0;
  const costCalculator = createDefaultCostCalculator();
  // let justified: accumulated real cost from engine metrics, updated on each turn completion
  let totalCostUsd = 0;

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
    presetContributions: activatedStacks.contributions,
  });

  // Late-binding event sink for forge/monitor SSE events
  // let justified: mutable ref set when adminBridge is created
  let emitDashboardEvent: ((event: DashboardEvent) => void) | undefined;

  // ------------------------------------------------------------------
  // 7. Assemble runtime
  // ------------------------------------------------------------------
  progress("assemble", "Assembling runtime");
  const { runtime, dispose: forgeSystemDispose } = await createForgeConfiguredKoi({
    manifest,
    adapter,
    middleware: composed.middleware,
    providers: composed.providers,
    extensions: [],
    ...(forgeBootstrap !== undefined ? { forge: forgeBootstrap.runtime } : {}),
    debug: { enabled: true },
    onDashboardEvent: (event: DashboardEvent) => {
      emitDashboardEvent?.(event);
    },
  });

  // ------------------------------------------------------------------
  // 8. Connect channels
  // ------------------------------------------------------------------
  progress("channels", "Connecting channels");
  const channels: readonly ChannelAdapter[] = resolved.value.channels ?? [createCliChannel()];
  await Promise.all(channels.map((ch) => ch.connect()));

  // ------------------------------------------------------------------
  // 9. Demo seed
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
  // 10. Admin panel
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

  const debugApi = runtime.debug;

  // Build full contribution graph snapshot for the debug API
  const fullContributions: RuntimeContributionGraph = addPostCompositionContributions(
    composed.contributions,
    channelNames,
    adapter.engineId,
    modelName,
  );

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
    cost: {
      async getSnapshot(): Promise<CostSnapshot> {
        const totalCost = totalCostUsd;
        const agents: readonly AgentCostEntry[] = [
          {
            agentId: "" as import("@koi/core").AgentId,
            name: manifest.name,
            model: modelName,
            turns: 0,
            costUsd: totalCost,
            budgetUsed: totalCost,
            budgetLimit: SESSION_BUDGET,
          },
        ];
        return {
          sessionBudget: { used: totalCost, limit: SESSION_BUDGET },
          dailyBudget: { used: totalCost, limit: 10.0 },
          monthlyBudget: { used: totalCost, limit: 50.0 },
          agents,
          cascade: { tiers: [], savingsUsd: 0, baselineModel: "sonnet" },
          circuitBreaker: { state: "CLOSED", failures: 0, threshold: 5, windowMs: 60_000 },
          timestamp: Date.now(),
        };
      },
    },
    ...(orch.hasAny
      ? { orchestration: orch.orchestration, orchestrationCommands: orch.orchestrationCommands }
      : {}),
    ...(activatedStacks.governanceCommands !== undefined
      ? { governanceCommands: activatedStacks.governanceCommands }
      : {}),
    ...(debugApi !== undefined
      ? {
          debug: {
            getInventory: (_agentId) =>
              debugApi.getInventory(
                buildDebugExtraItems({
                  channels: channelNames,
                  skills: skillNames,
                  model: modelName,
                  engineAdapter: adapter.engineId,
                  tools: manifest.tools,
                  subsystems: collectActiveSubsystems({
                    nexusEnabled: nexus.middlewares !== undefined && nexus.middlewares.length > 0,
                    forgeEnabled: forgeBootstrap !== undefined,
                    autonomousEnabled: autonomous !== undefined,
                    sandboxEnabled: sandboxBridge !== undefined,
                  }),
                }),
              ),
            getTrace: (_agentId, turnIndex) => debugApi.getTrace(turnIndex),
            getContributions: () => fullContributions,
          },
        }
      : {}),
  });

  // Wire forge/monitor SSE event sink now that the bridge exists
  emitDashboardEvent = adminBridge.emitEvent;

  // Wire task board → SSE push: task status changes appear in TUI in real-time
  if (autonomous !== undefined) {
    autonomous.bindDashboardEvent(adminBridge.emitEvent);
  }

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

  // Try up to 10 ports starting from adminPort to handle stale processes
  let server: ReturnType<typeof Bun.serve> | undefined;
  let actualPort = adminPort;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      server = Bun.serve({
        port: actualPort,
        idleTimeout: 255,
        async fetch(req: Request): Promise<Response> {
          const adminResponse = await dashboardResult.handler(req);
          if (adminResponse !== null) return adminResponse;
          return new Response("Not Found", { status: 404 });
        },
      });
      break;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      if (
        msg.includes("EADDRINUSE") ||
        msg.includes("address already in use") ||
        msg.includes("port")
      ) {
        actualPort = adminPort + attempt + 1;
        continue;
      }
      throw err;
    }
  }
  if (server === undefined) {
    throw new Error(
      `Failed to start admin server: ports ${String(adminPort)}-${String(actualPort)} all in use`,
    );
  }
  if (actualPort !== adminPort) {
    progress("port", `Port ${String(adminPort)} busy, using ${String(actualPort)} instead`);
  }

  // ------------------------------------------------------------------
  // 11. Provision demo agents
  // ------------------------------------------------------------------
  await provisionDemoAgents(demoPack, manifestPath, dispatcher, verbose);

  // ------------------------------------------------------------------
  // 12. Wire chat dispatch
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

      // Expand stateless-normalized content blocks ([user]: ..., [assistant]: ...)
      // into separate InboundMessages so the engine sees proper multi-turn history.
      const messages = expandLabeledBlocks(msg);
      const input: EngineInput = { kind: "messages", messages };
      const deltas: string[] = [];
      for await (const event of runtime.run(input)) {
        if (event.kind === "text_delta") deltas.push(event.delta);
        if (event.kind === "done" && adminBridge !== undefined) {
          adminBridge.updateMetrics({
            turns: event.output.metrics.turns,
            totalTokens: event.output.metrics.totalTokens,
          });
          // Accumulate real cost from engine metrics (costUsd is per-run, not cumulative)
          const metrics = event.output.metrics as unknown as Record<string, unknown>;
          if (typeof metrics.costUsd === "number") {
            totalCostUsd += metrics.costUsd;
          } else {
            // Fallback: estimate from token counts for this run
            totalCostUsd += costCalculator.calculate(
              modelName,
              event.output.metrics.inputTokens ?? 0,
              event.output.metrics.outputTokens ?? 0,
            );
          }
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

  const adminUrl = `http://localhost:${String(actualPort)}/admin/api`;

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
    if (options.nexusCleanup !== undefined) await options.nexusCleanup();
  };

  return { adminUrl, dispose };
}
