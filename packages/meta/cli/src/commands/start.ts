/**
 * `koi start` command — loads a koi.yaml manifest and runs the agent.
 *
 * Bootstrap sequence:
 * 1. RESOLVE:  Find manifest file (--manifest flag, positional arg, or default ./koi.yaml)
 * 2. VALIDATE: loadManifest() from @koi/manifest
 * 3. ASSEMBLE: Create EngineAdapter (engine-pi) with model terminal
 * 4. WIRE:     createKoi() from @koi/engine with middleware + providers
 * 5. START:    runtime.run() — async iterate events
 * 6. RENDER:   Write events to stdout/stderr
 * 7. SHUTDOWN: AbortController + SIGINT/SIGTERM handlers
 */

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createCliChannel } from "@koi/channel-cli";
import type { CliCommandDeps } from "@koi/cli-commands";
import { createContextExtension } from "@koi/context";
import type { ChannelAdapter, EngineInput } from "@koi/core";
import { brickId } from "@koi/core";
import type { AdminPanelBridgeResult, DashboardHandlerResult } from "@koi/dashboard-api";
import { createAdminPanelBridge, createDashboardHandler } from "@koi/dashboard-api";
import type { DashboardEvent } from "@koi/dashboard-types";
import { createPiAdapter } from "@koi/engine-pi";
import { createForgeConfiguredKoi } from "@koi/forge";
import { getEngineName, loadManifest } from "@koi/manifest";
import { EXIT_CONFIG } from "@koi/shutdown";
import { createAgentDispatcher } from "../agent-dispatcher.js";
import type { AgentChatBridge } from "../agui-chat-bridge.js";
import type { StartFlags } from "../args.js";
import { bootstrapForgeOrWarn } from "../bootstrap-forge.js";
import { createChatRouter } from "../chat-router.js";
import { composeRuntimeMiddleware } from "../compose-middleware.js";
import { addPostCompositionContributions } from "../contribution-graph.js";
import { buildDebugExtraItems, collectActiveSubsystems } from "../debug-inventory-items.js";
import {
  createLocalFileSystem,
  extractTextFromBlocks,
  persistChatExchangeSafely,
  resolveDashboardAssetsDir,
} from "../helpers.js";
import { renderEvent } from "../render-event.js";
import { formatResolutionError, resolveAgent } from "../resolve-agent.js";
import { resolveAutonomousOrWarn } from "../resolve-autonomous.js";
import { mergeBootstrapContext } from "../resolve-bootstrap.js";
import { resolveNexusOrWarn, runNexusBuildIfNeeded } from "../resolve-nexus.js";
import { resolveOrchestrationFromAgent } from "../resolve-orchestration.js";
import { resolveTemporalOrWarn } from "../resolve-temporal.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_MANIFEST_PATH = "koi.yaml";
const MANIFEST_SUGGESTION_LIMIT = 3;
const MANIFEST_SEARCH_DEPTH = 4;
const SKIPPED_MANIFEST_SEARCH_DIRS = new Set(["build", "coverage", "dist", "node_modules"]);

function toDisplayPath(path: string): string {
  return sep === "\\" ? path.replaceAll("\\", "/") : path;
}

async function resolveManifestPath(input: string | undefined): Promise<string> {
  const candidate = input ?? DEFAULT_MANIFEST_PATH;
  const nestedManifestPath = join(candidate, DEFAULT_MANIFEST_PATH);

  try {
    const info = await stat(candidate);
    if (info.isDirectory()) return nestedManifestPath;
  } catch {
    if (await Bun.file(nestedManifestPath).exists()) return nestedManifestPath;
  }

  return candidate;
}

async function findNearbyManifests(rootDir: string): Promise<readonly string[]> {
  const suggestions: string[] = [];
  const queue: Array<{ readonly dir: string; readonly depth: number }> = [
    { dir: rootDir, depth: 0 },
  ];

  while (queue.length > 0 && suggestions.length < MANIFEST_SUGGESTION_LIMIT) {
    const current = queue.shift();
    if (current === undefined) break;

    let entries: Dirent[];
    try {
      entries = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIPPED_MANIFEST_SEARCH_DIRS.has(entry.name)) {
        continue;
      }

      const fullPath = join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < MANIFEST_SEARCH_DEPTH) {
          queue.push({ dir: fullPath, depth: current.depth + 1 });
        }
        continue;
      }

      if (!entry.isFile() || entry.name !== DEFAULT_MANIFEST_PATH) continue;

      suggestions.push(toDisplayPath(relative(rootDir, fullPath) || DEFAULT_MANIFEST_PATH));
      if (suggestions.length >= MANIFEST_SUGGESTION_LIMIT) break;
    }
  }

  return suggestions;
}

async function formatManifestLoadFailure(
  manifestPath: string,
  errorMessage: string,
): Promise<string> {
  let message = `Failed to load manifest: ${errorMessage}\n`;

  if (manifestPath !== DEFAULT_MANIFEST_PATH) {
    return message;
  }

  message +=
    "hint: `koi start` defaults to `./koi.yaml`; pass a manifest path or `cd` into an agent directory\n";

  const suggestions = await findNearbyManifests(process.cwd());
  if (suggestions.length === 0) {
    return message;
  }

  message += "hint: nearby manifests:\n";
  for (const suggestion of suggestions) {
    message += `  koi start ${suggestion}\n`;
  }

  return message;
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function runStart(flags: StartFlags): Promise<void> {
  // Validate --nexus-build / --nexus-source and run uv sync if needed
  runNexusBuildIfNeeded(flags.nexusBuild, flags.nexusSource);

  // 1. RESOLVE: Find manifest path
  const manifestPath = await resolveManifestPath(flags.manifest ?? flags.directory);

  // Compute workspace root early — used for chat persistence in all message handlers
  const startWorkspaceRoot = resolve(dirname(manifestPath));

  // 2. VALIDATE: Load and validate manifest
  const loadResult = await loadManifest(manifestPath);
  if (!loadResult.ok) {
    process.stderr.write(await formatManifestLoadFailure(manifestPath, loadResult.error.message));
    process.stderr.write("hint: run `koi doctor --repair` to auto-fix common issues\n");
    process.exit(EXIT_CONFIG);
  }

  const { manifest, warnings } = loadResult.value;

  // Print warnings
  for (const warning of warnings) {
    process.stderr.write(`warn: ${warning.message}\n`);
  }

  // 3. DRY RUN: If --dry-run, print manifest and exit
  const engineName = getEngineName(manifest);

  if (flags.dryRun) {
    process.stderr.write(`Manifest: ${manifest.name} v${manifest.version}\n`);
    process.stderr.write(`Model: ${manifest.model.name}\n`);
    process.stderr.write(`Engine: ${engineName}\n`);
    process.stderr.write("Dry run complete.\n");
    return;
  }

  // 4. Resolve Nexus + autonomous in parallel (before forge, so search backends are available)
  const [nexusResolution, autonomousResolution] = await Promise.all([
    resolveNexusOrWarn(
      flags.nexusUrl,
      manifest.nexus?.url,
      flags.verbose,
      undefined,
      flags.nexusSource,
    ),
    resolveAutonomousOrWarn(manifest, flags.verbose),
  ]);
  const nexus = nexusResolution.state;
  const autonomous = autonomousResolution.result;

  // 4b. Bootstrap forge system (before resolution, so forgeStore is available)
  // let justified: tracks current session ID for forge counter scoping
  let currentStartSessionId = `start:${manifest.name}:0`;
  // let justified: incremented per REPL message to generate unique session IDs
  let startSessionCounter = 0;

  const forgeResolution = await bootstrapForgeOrWarn(
    manifest,
    () => currentStartSessionId,
    flags.verbose,
    undefined,
    nexus.search,
  );
  const forgeBootstrap = forgeResolution.result?.bootstrap;
  const sandboxBridge = forgeResolution.result?.sandboxBridge;

  // 4c. Create AG-UI chat bridge for admin chat endpoint (loaded lazily)
  let chatBridge: AgentChatBridge | undefined;
  if (flags.admin) {
    const { createAgentChatBridge } = await import("../agui-chat-bridge.js");
    chatBridge = createAgentChatBridge();
  }

  // 5. RESOLVE: Resolve manifest into runtime instances (middleware + model)
  // Pass forgeStore so companion skills get registered during resolution
  const modelName = manifest.model.name;
  const resolved = await resolveAgent({
    manifestPath,
    manifest,
    ...(forgeBootstrap !== undefined ? { forgeStore: forgeBootstrap.store } : {}),
  });
  if (!resolved.ok) {
    process.stderr.write(formatResolutionError(resolved.error));
    process.stderr.write("hint: run `koi doctor --repair` to auto-fix common issues\n");
    if (sandboxBridge !== undefined) {
      await sandboxBridge.dispose();
    }
    if (autonomous !== undefined) {
      await autonomous.dispose();
    }
    if (nexus.dispose !== undefined) {
      await nexus.dispose();
    }
    process.exit(EXIT_CONFIG);
  }

  // 6. ASSEMBLE: Use resolved engine or fall back to pi adapter
  // let justified: adapter is recreated when /model switches to a different model
  let adapter = resolved.value.engine ?? createPiAdapter({ model: manifest.model.name });
  const hasCustomEngine = resolved.value.engine !== undefined;

  // 6. WIRE: Create the Koi runtime with resolved middleware + context extension
  // Resolve bootstrap sources if configured, then merge with explicit sources
  const contextConfig = await mergeBootstrapContext(manifest.context, manifestPath, manifest.name);
  const contextExt = createContextExtension(contextConfig);
  const extensions = contextExt !== undefined ? [contextExt] : [];

  // Data source auto-discovery (non-fatal)
  let dataSourceProvider: import("@koi/core").ComponentProvider | undefined;
  let dataSourceTools: readonly import("@koi/core").Tool[] = [];
  try {
    const { createDataSourceStack } = await import("@koi/data-source-stack");
    const dsStack = await createDataSourceStack({
      manifestEntries: (manifest as unknown as Record<string, unknown>).dataSources as
        | readonly import("@koi/data-source-stack").ManifestDataSourceEntry[]
        | undefined,
      env: process.env,
      // TODO(#954): Interactive consent via @clack/prompts TUI for `koi start`.
      consent: { approve: async () => true },
    });
    if (dsStack.discoveredSources.length > 0) {
      dataSourceProvider = dsStack.provider;
      dataSourceTools = dsStack.tools;
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
    presetContributions: [
      nexusResolution.contribution,
      forgeResolution.contribution,
      autonomousResolution.contribution,
    ],
  });

  // Late-binding event sink for forge/monitor SSE events.
  // Created before the runtime so forge middleware can push events immediately;
  // adminBridge.emitEvent is wired after the bridge is created.
  // let justified: mutable ref set when adminBridge is created
  let emitDashboardEvent: ((event: DashboardEvent) => void) | undefined;

  // let justified: runtime is recreated when /model switches to a different model
  let { runtime } = await createForgeConfiguredKoi({
    manifest,
    adapter,
    middleware: composed.middleware,
    providers: composed.providers,
    extensions,
    ...(forgeBootstrap !== undefined ? { forge: forgeBootstrap.runtime } : {}),
    ...(flags.admin
      ? {
          debug: { enabled: true },
          onDashboardEvent: (event: DashboardEvent) => {
            emitDashboardEvent?.(event);
          },
        }
      : {}),
  });

  // 6b. Set up AbortController early — needed by commandDeps for /cancel
  const controller = new AbortController();
  let shuttingDown = false; // let: mutated by signal handler
  // let justified: per-run abort controller for /cancel without full shutdown
  let cancelCurrentRun: (() => void) | undefined;

  function shutdown(): void {
    if (shuttingDown) {
      // Second signal — force exit immediately
      process.stderr.write("\nForce exit.\n");
      process.exit(1);
    }
    shuttingDown = true;
    process.stderr.write("\nShutting down...\n");
    controller.abort();
  }

  process.on("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // 6c. Set up channels — use resolved channels or fall back to CLI channel with slash commands
  // Admin deps use closures that late-bind to adminBridge (set up in 6d below).
  // let justified: conditionally set inside try/catch, read by closures + cleanup
  let adminBridge: AdminPanelBridgeResult | undefined;
  // let justified: conditionally set when --admin, disposed at cleanup
  let adminDispatcher: ReturnType<typeof createAgentDispatcher> | undefined;

  // let justified: mutable model name — /model updates it and rebuilds the runtime.
  let activeModelName = modelName;
  // let justified: mutable active agent target — /attach switches it.
  // When undefined, messages go to the primary runtime. When set to an agentId,
  // messages route through the dispatched agent's chat handler.
  let activeDispatchedAgentId: string | undefined;
  // let justified: set to true while model-switch runtime rebuild is in progress
  let switchingModel = false;

  /** Rebuild the engine adapter + runtime for a new model name. */
  async function rebuildRuntimeForModel(newModel: string): Promise<void> {
    switchingModel = true;
    try {
      // Build the new runtime BEFORE disposing the old one — if construction
      // fails, the previous runtime remains intact and usable.
      const newAdapter = createPiAdapter({ model: newModel });
      const rebuilt = await createForgeConfiguredKoi({
        manifest,
        adapter: newAdapter,
        middleware: composed.middleware,
        providers: composed.providers,
        extensions,
        ...(forgeBootstrap !== undefined ? { forge: forgeBootstrap.runtime } : {}),
        ...(flags.admin
          ? {
              debug: { enabled: true },
              onDashboardEvent: (event: DashboardEvent) => {
                emitDashboardEvent?.(event);
              },
            }
          : {}),
      });
      // New runtime is good — now dispose the old one and swap
      const oldRuntime = runtime;
      runtime = rebuilt.runtime;
      adapter = newAdapter;
      activeModelName = newModel;
      await oldRuntime.dispose();
    } finally {
      switchingModel = false;
    }
  }

  const commandDeps: CliCommandDeps = {
    cancelStream: () => {
      cancelCurrentRun?.();
    },
    listModels: () => {
      // Return well-known models for the active provider to enable dynamic tab completion.
      // The manifest model's provider prefix (e.g., "anthropic:") determines the catalog.
      const colonIdx = activeModelName.indexOf(":");
      const provider = colonIdx !== -1 ? activeModelName.slice(0, colonIdx) : "";
      const KNOWN_MODELS: Readonly<Record<string, readonly string[]>> = {
        anthropic: [
          "anthropic:claude-opus-4-6",
          "anthropic:claude-sonnet-4-6",
          "anthropic:claude-haiku-4-5-20251001",
        ],
        openai: [
          "openai:gpt-4.1",
          "openai:gpt-4.1-mini",
          "openai:gpt-4.1-nano",
          "openai:o3",
          "openai:o4-mini",
        ],
        google: ["google:gemini-2.5-pro", "google:gemini-2.5-flash"],
      };
      const providerModels = KNOWN_MODELS[provider] ?? [];
      // Include the active model if not already in the list
      if (!providerModels.includes(activeModelName)) {
        return [activeModelName, ...providerModels];
      }
      return [...providerModels];
    },
    currentModel: () => activeModelName,
    setModel: async (name: string) => {
      if (hasCustomEngine) {
        return {
          ok: false,
          message: "Model switching is not supported with custom engine adapters",
        } as const;
      }
      try {
        await rebuildRuntimeForModel(name);
        return { ok: true } as const;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, message: `Failed to switch model: ${msg}` } as const;
      }
    },
    output: process.stdout,
    exit: () => {
      shutdown();
    },
    // Admin-only deps: closures capture adminBridge/adminDispatcher set up later.
    // Before admin is initialized, these return unavailable/empty results.
    ...(flags.admin
      ? {
          getStatus: async () => {
            if (adminBridge === undefined) return "Admin server starting...";
            const target =
              activeDispatchedAgentId !== undefined
                ? ` (attached: ${activeDispatchedAgentId})`
                : "";
            return `Agent: ${manifest.name} — model: ${activeModelName}${target}`;
          },
          listAgents: async () => {
            if (adminBridge === undefined) return [];
            const agents = await adminBridge.dataSource.listAgents();
            return agents.map((a) => ({
              name: a.name,
              agentId: a.agentId,
              state: a.state,
            }));
          },
          attachAgent: async (name: string) => {
            if (adminDispatcher === undefined) {
              return { ok: false, message: "Agent dispatch not available yet" } as const;
            }
            // Find agent by name in dispatched agents
            for (const [id, agent] of adminDispatcher.dispatched) {
              if (agent.name.toLowerCase() === name.toLowerCase()) {
                activeDispatchedAgentId = id;
                return { ok: true } as const;
              }
            }
            // "primary" or the manifest agent name returns to the primary runtime
            if (
              name.toLowerCase() === "primary" ||
              name.toLowerCase() === manifest.name.toLowerCase()
            ) {
              activeDispatchedAgentId = undefined;
              return { ok: true } as const;
            }
            const names = [...adminDispatcher.dispatched.values()].map((a) => a.name);
            return {
              ok: false,
              message: `Agent not found: ${name}. Available: ${["primary", ...names].join(", ")}`,
            } as const;
          },
          listSessions: async () => {
            // Read session chat logs from the local workspace filesystem
            const agentDirName = adminBridge?.agentId ?? manifest.name;
            const chatDir = join(startWorkspaceRoot, "agents", agentDirName, "session", "chat");
            try {
              const entries = await readdir(chatDir);
              const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));
              // Stat files in parallel to get real timestamps
              const results = await Promise.all(
                jsonlFiles.map(async (f) => {
                  try {
                    const fileStat = await stat(join(chatDir, f));
                    return {
                      sessionId: f.replace(".jsonl", ""),
                      agentName: manifest.name,
                      startedAt: fileStat.mtimeMs,
                    };
                  } catch {
                    return {
                      sessionId: f.replace(".jsonl", ""),
                      agentName: manifest.name,
                      startedAt: 0,
                    };
                  }
                }),
              );
              return results;
            } catch {
              return [];
            }
          },
        }
      : {}),
    // Forge deps: closures capture forgeBootstrap which is already set up above.
    ...(forgeBootstrap !== undefined
      ? {
          forgeSearch: async (query: string) => {
            const result = await forgeBootstrap.store.search({ text: query, limit: 10 });
            if (!result.ok) return [];
            return result.value.map((b) => ({
              id: b.id,
              name: b.name,
              description: b.description ?? "",
              kind: b.kind,
            }));
          },
          forgeInstall: async (id: string) => {
            const bid = brickId(id);
            const loadResult = await forgeBootstrap.store.load(bid);
            if (!loadResult.ok) {
              return { ok: false, message: `Brick not found: ${id}` } as const;
            }
            // Activate the brick — sets lifecycle to "active" so the forge runtime
            // picks it up via its store watch listener. The tool becomes available
            // to the agent on the next turn without re-assembly.
            const activateResult = await forgeBootstrap.store.update(bid, {
              lifecycle: "active",
            });
            if (!activateResult.ok) {
              return {
                ok: false,
                message: `Failed to activate: ${activateResult.error.message}`,
              } as const;
            }
            return { ok: true } as const;
          },
          forgeInspect: async (id: string) => {
            const loadResult = await forgeBootstrap.store.load(brickId(id));
            if (!loadResult.ok) return `Brick not found: ${id}`;
            const brick = loadResult.value;
            return [
              `Name: ${brick.name}`,
              `Kind: ${brick.kind}`,
              `Description: ${brick.description ?? "(none)"}`,
              ...(brick.tags !== undefined && brick.tags.length > 0
                ? [`Tags: ${brick.tags.join(", ")}`]
                : []),
            ].join("\n");
          },
        }
      : {}),
  };

  // Inject commandDeps into CLI channels — whether manifest-resolved or default.
  // Manifest-resolved CLI channels are created by the descriptor without commandDeps,
  // so we replace them with a fresh instance that carries slash command support.
  const resolvedChannels = resolved.value.channels;
  const cliManifestOptions = (manifest.channels ?? []).find(
    (c) => c.name === "@koi/channel-cli" || c.name === "cli",
  )?.options as Readonly<Record<string, unknown>> | undefined;
  const channels: readonly ChannelAdapter[] =
    resolvedChannels !== undefined
      ? resolvedChannels.map((ch) => {
          if (ch.name === "cli") {
            return createCliChannel({
              commandDeps,
              ...(typeof cliManifestOptions?.theme === "string"
                ? { theme: cliManifestOptions.theme }
                : {}),
              ...(typeof cliManifestOptions?.prompt === "string"
                ? { prompt: cliManifestOptions.prompt }
                : {}),
            });
          }
          return ch;
        })
      : [createCliChannel({ commandDeps })];
  for (const ch of channels) {
    await ch.connect();
  }

  // 6d. Optional admin panel server (--admin flag)
  const DEFAULT_ADMIN_PORT = 3100;
  // let justified: conditionally set inside try/catch, called at cleanup
  let stopAdmin: (() => void) | undefined;

  // let justified: conditionally set when --temporal-url, disposed at cleanup
  let temporalAdmin: Awaited<ReturnType<typeof resolveTemporalOrWarn>>;

  if (flags.admin) {
    try {
      const channelNames = channels.map((ch) => ch.name);
      const skillNames = (manifest.skills ?? []).map((s) => s.name);

      const { dirname: pathDirname, resolve: pathResolve } = await import("node:path");
      const workspaceRoot = pathResolve(pathDirname(manifestPath));

      temporalAdmin = await resolveTemporalOrWarn(flags.temporalUrl, flags.verbose);

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
        onDashboardEvent: (event) => {
          emitDashboardEvent?.(event as DashboardEvent);
        },
      });
      adminDispatcher = dispatcher;

      const debugApi = runtime.debug;
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
        ...(debugApi !== undefined
          ? {
              debug: {
                getInventory: (requestedAgentId) => {
                  if (requestedAgentId !== runtime.agent.pid.id) {
                    return { agentId: String(requestedAgentId), items: [], timestamp: Date.now() };
                  }
                  return debugApi.getInventory(
                    buildDebugExtraItems({
                      channels: channelNames,
                      skills: skillNames,
                      model: modelName,
                      engineAdapter: adapter.engineId,
                      tools: manifest.tools,
                      subsystems: collectActiveSubsystems({
                        nexusEnabled:
                          nexus.middlewares !== undefined && nexus.middlewares.length > 0,
                        forgeEnabled: forgeBootstrap !== undefined,
                        autonomousEnabled: autonomous !== undefined,
                        sandboxEnabled: sandboxBridge !== undefined,
                        temporalEnabled: temporalAdmin !== undefined,
                      }),
                    }),
                  );
                },
                getTrace: (requestedAgentId, turnIndex) => {
                  if (requestedAgentId !== runtime.agent.pid.id) return undefined;
                  return debugApi.getTrace(turnIndex);
                },
                getContributions: () =>
                  addPostCompositionContributions(
                    composed.contributions,
                    channelNames,
                    adapter.engineId,
                    modelName,
                  ),
              },
            }
          : {}),
      });

      // Wire forge/monitor SSE event sink now that the bridge exists
      emitDashboardEvent = adminBridge.emitEvent;

      // Build routing chat handler: primary → chatBridge, dispatched → dispatcher
      const routingChatHandler =
        chatBridge !== undefined && adminDispatcher !== undefined
          ? createChatRouter({
              primaryHandler: chatBridge.handler,
              getDispatchedHandler: adminDispatcher.getChatHandler,
              isPrimaryAgent: (id) => id === adminBridge?.agentId,
            })
          : chatBridge?.handler;

      const assetsDir = resolveDashboardAssetsDir();
      const dashboardResult: DashboardHandlerResult = createDashboardHandler(
        {
          ...adminBridge,
          ...(routingChatHandler !== undefined ? { agentChatHandler: routingChatHandler } : {}),
        },
        {
          cors: true,
          ...(assetsDir !== undefined ? { assetsDir } : {}),
        },
      );

      const server = Bun.serve({
        port: DEFAULT_ADMIN_PORT,
        async fetch(req: Request): Promise<Response> {
          const adminResponse = await dashboardResult.handler(req);
          if (adminResponse !== null) return adminResponse;
          return new Response("Not Found", { status: 404 });
        },
      });

      stopAdmin = () => {
        server.stop(true);
        dashboardResult.dispose();
      };

      process.stderr.write(`Admin panel: http://localhost:${String(server.port)}/admin\n`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`warn: admin panel failed to start: ${message}\n`);
    }
  }

  // Agent directory name for chat persistence — matches the bridge's synthetic agentId
  // so the TUI/session-picker can read back shared chat logs at the same path.
  const persistAgentId = adminBridge?.agentId ?? manifest.name;

  // 7. Print startup info
  if (flags.verbose) {
    process.stderr.write(`Agent: ${manifest.name} v${manifest.version}\n`);
    process.stderr.write(`Engine: ${engineName}\n`);
    process.stderr.write(`Model: ${modelName}\n`);
  }

  process.stderr.write(`Agent "${manifest.name}" ready. Type a message or Ctrl+C to stop.\n\n`);

  // 9. REPL loop: channel messages -> engine -> stdout
  // Concurrent run protection: single flag guards against overlapping engine runs.
  // With multiple channels this is a best-effort guard, not a strict mutex.
  let processing = false; // let: mutated as concurrency flag across message handlers

  // Wire AG-UI chat dispatch (reuses the same processing guard)
  if (chatBridge !== undefined) {
    const bridge = chatBridge;

    bridge.wireDispatch(async (msg) => {
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
        // Persist to shared chat log (best-effort, warns on failure)
        await persistChatExchangeSafely(
          startWorkspaceRoot,
          persistAgentId,
          threadId,
          text,
          deltas.join(""),
        );
      } finally {
        processing = false;
      }
    });
  }

  const unsubscribers = channels.map((ch) =>
    ch.onMessage(async (inbound) => {
      const text = extractTextFromBlocks(inbound.content);

      if (text.trim() === "") return;

      if (processing || switchingModel) {
        process.stderr.write("(busy — please wait for the current response)\n");
        return;
      }

      processing = true;
      startSessionCounter++;
      currentStartSessionId = `start:${manifest.name}:${String(startSessionCounter)}`;
      const input: EngineInput = { kind: "text", text };

      // Per-run cancel: /cancel aborts this flag, not the entire process
      let runCancelled = false; // let: mutated by cancelCurrentRun closure
      cancelCurrentRun = () => {
        runCancelled = true;
      };

      try {
        // Route to dispatched agent if /attach switched the target
        if (activeDispatchedAgentId !== undefined && adminDispatcher !== undefined) {
          const handler = adminDispatcher.getChatHandler(activeDispatchedAgentId);
          if (handler !== undefined) {
            // Send proper AG-UI RunAgentInput request
            const threadId = `thread-${Date.now().toString(36)}`;
            const runId = `run-${Date.now().toString(36)}`;
            const body = JSON.stringify({
              threadId,
              runId,
              messages: [{ id: `msg-${Date.now().toString(36)}`, role: "user", content: text }],
              tools: [],
              context: [],
            });
            const response = await handler(
              new Request("http://local/chat", {
                method: "POST",
                body,
                headers: { "content-type": "application/json" },
              }),
            );
            // Parse SSE stream to extract text deltas
            const sseText = await response.text();
            for (const line of sseText.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                const event = JSON.parse(line.slice(6)) as {
                  readonly type: string;
                  readonly delta?: string;
                };
                if (event.type === "TEXT_MESSAGE_CONTENT" && event.delta !== undefined) {
                  process.stdout.write(event.delta);
                }
              } catch {
                // Skip malformed SSE lines
              }
            }
            process.stdout.write("\n");
          } else {
            process.stderr.write(
              `Agent ${activeDispatchedAgentId} is no longer available. Reverting to primary.\n`,
            );
            activeDispatchedAgentId = undefined;
          }
        } else {
          const deltas: string[] = [];
          for await (const event of runtime.run(input)) {
            if (controller.signal.aborted || runCancelled) break;
            renderEvent(event, { verbose: flags.verbose });
            if (event.kind === "text_delta") deltas.push(event.delta);
            if (event.kind === "done" && adminBridge !== undefined) {
              const m = event.output.metrics;
              adminBridge.updateMetrics({ turns: m.turns, totalTokens: m.totalTokens });
            }
          }
          // Persist to shared chat log (best-effort, warns on failure)
          await persistChatExchangeSafely(
            startWorkspaceRoot,
            persistAgentId,
            currentStartSessionId,
            text,
            deltas.join(""),
          );
        }
      } catch (error: unknown) {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`Error: ${message}\n`);
        }
      } finally {
        processing = false;
        cancelCurrentRun = undefined;
      }
    }),
  );

  // 10. Wait for abort signal
  await new Promise<void>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(), { once: true });
  });

  // 11. Cleanup
  process.removeListener("SIGINT", shutdown);
  process.removeListener("SIGTERM", shutdown);
  for (const unsub of unsubscribers) {
    unsub();
  }
  for (const ch of channels) {
    await ch.disconnect();
  }
  if (stopAdmin !== undefined) {
    stopAdmin();
  }
  if (adminDispatcher !== undefined) {
    await adminDispatcher.dispose();
  }
  if (temporalAdmin !== undefined) {
    await temporalAdmin.dispose();
  }
  await runtime.dispose();
  if (autonomous !== undefined) {
    await autonomous.dispose();
  }
  forgeBootstrap?.dispose();
  if (sandboxBridge !== undefined) {
    await sandboxBridge.dispose();
  }
  if (nexus.dispose !== undefined) {
    await nexus.dispose();
  }

  process.stderr.write("Goodbye.\n");
}
