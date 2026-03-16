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
import { createContextExtension } from "@koi/context";
import type { ChannelAdapter, EngineInput } from "@koi/core";
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
  const [nexus, autonomous] = await Promise.all([
    resolveNexusOrWarn(
      flags.nexusUrl,
      manifest.nexus?.url,
      flags.verbose,
      undefined,
      flags.nexusSource,
    ),
    resolveAutonomousOrWarn(manifest, flags.verbose),
  ]);

  // 4b. Bootstrap forge system (before resolution, so forgeStore is available)
  // let justified: tracks current session ID for forge counter scoping
  let currentStartSessionId = `start:${manifest.name}:0`;
  // let justified: incremented per REPL message to generate unique session IDs
  let startSessionCounter = 0;

  const forgeResult = await bootstrapForgeOrWarn(
    manifest,
    () => currentStartSessionId,
    flags.verbose,
    undefined,
    nexus.search,
  );
  const forgeBootstrap = forgeResult?.bootstrap;
  const sandboxBridge = forgeResult?.sandboxBridge;

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
    process.exit(EXIT_CONFIG);
  }

  // 6. ASSEMBLE: Use resolved engine or fall back to pi adapter
  const adapter = resolved.value.engine ?? createPiAdapter({ model: manifest.model.name });

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
  });

  // Late-binding event sink for forge/monitor SSE events.
  // Created before the runtime so forge middleware can push events immediately;
  // adminBridge.emitEvent is wired after the bridge is created.
  // let justified: mutable ref set when adminBridge is created
  let emitDashboardEvent: ((event: DashboardEvent) => void) | undefined;

  const { runtime } = await createForgeConfiguredKoi({
    manifest,
    adapter,
    middleware: composed.middleware,
    providers: composed.providers,
    extensions,
    ...(forgeBootstrap !== undefined ? { forge: forgeBootstrap.runtime } : {}),
    ...(flags.admin
      ? {
          onDashboardEvent: (event: DashboardEvent) => {
            emitDashboardEvent?.(event);
          },
        }
      : {}),
  });

  // 6b. Set up channels — use resolved channels or fall back to CLI channel
  const channels: readonly ChannelAdapter[] = resolved.value.channels ?? [createCliChannel()];
  for (const ch of channels) {
    await ch.connect();
  }

  // 6c. Optional admin panel server (--admin flag)
  const DEFAULT_ADMIN_PORT = 3100;
  // let justified: conditionally set inside try/catch, called at cleanup
  let stopAdmin: (() => void) | undefined;
  // let justified: conditionally set when --admin, read in REPL loop for metrics
  let adminBridge: AdminPanelBridgeResult | undefined;
  // let justified: conditionally set when --admin, disposed at cleanup
  let adminDispatcher: ReturnType<typeof createAgentDispatcher> | undefined;

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

  // 7. Set up AbortController for graceful shutdown
  const controller = new AbortController();
  let shuttingDown = false;

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

  // 8. Print startup info
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

      if (processing) {
        process.stderr.write("(busy — please wait for the current response)\n");
        return;
      }

      processing = true;
      startSessionCounter++;
      currentStartSessionId = `start:${manifest.name}:${String(startSessionCounter)}`;
      const input: EngineInput = { kind: "text", text };

      try {
        const deltas: string[] = [];
        for await (const event of runtime.run(input)) {
          if (controller.signal.aborted) break;
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
