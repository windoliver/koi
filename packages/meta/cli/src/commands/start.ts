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

import { createCliChannel } from "@koi/channel-cli";
import { createContextExtension } from "@koi/context";
import type { ChannelAdapter, EngineEvent, EngineInput, SandboxExecutor } from "@koi/core";
import type { AdminPanelBridgeResult, DashboardHandlerResult } from "@koi/dashboard-api";
import { createAdminPanelBridge, createDashboardHandler } from "@koi/dashboard-api";
import { createPiAdapter } from "@koi/engine-pi";
import { createForgeBootstrap, createForgeConfiguredKoi } from "@koi/forge";
import { getEngineName, loadManifest } from "@koi/manifest";
import { createSandboxCommand, restrictiveProfile } from "@koi/sandbox";
import type { SandboxBridge } from "@koi/sandbox-ipc";
import { bridgeToExecutor, createSandboxBridge } from "@koi/sandbox-ipc";
import { EXIT_CONFIG } from "@koi/shutdown";
import type { StartFlags } from "../args.js";
import {
  createLocalFileSystem,
  extractTextFromBlocks,
  resolveDashboardAssetsDir,
} from "../helpers.js";
import { formatResolutionError, resolveAgent } from "../resolve-agent.js";
import { mergeBootstrapContext } from "../resolve-bootstrap.js";
import { resolveNexusOrWarn } from "../resolve-nexus.js";
import { resolveTemporalOrWarn } from "../resolve-temporal.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safely checks if forge is enabled in the manifest's extension fields. */
function isForgeEnabled(manifest: { readonly forge?: unknown }): boolean {
  const forge = manifest.forge;
  if (forge === null || forge === undefined || typeof forge !== "object") return false;
  const obj = forge as Record<string, unknown>;
  return obj.enabled === true;
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
      // Internal events — no user-visible output
      break;
  }
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function runStart(flags: StartFlags): Promise<void> {
  // 1. RESOLVE: Find manifest path
  const manifestPath = flags.manifest ?? flags.directory ?? "koi.yaml";

  // 2. VALIDATE: Load and validate manifest
  const loadResult = await loadManifest(manifestPath);
  if (!loadResult.ok) {
    process.stderr.write(`Failed to load manifest: ${loadResult.error.message}\n`);
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

  // 4. Bootstrap forge system (before resolution, so forgeStore is available)
  // Only create sandbox bridge when forge is enabled to avoid temp file leaks
  // let justified: mutable binding — set inside try/catch, read for cleanup
  let sandboxBridge: SandboxBridge | undefined;
  // let justified: tracks current session ID for forge counter scoping
  let currentStartSessionId = `start:${manifest.name}:0`;
  // let justified: incremented per REPL message to generate unique session IDs
  let startSessionCounter = 0;

  const forgeEnabled = isForgeEnabled(manifest);
  // let justified: conditionally set when forge is enabled
  let forgeBootstrap: ReturnType<typeof createForgeBootstrap>;

  if (forgeEnabled) {
    // let justified: conditionally assigned in try/catch
    let forgeExecutor: SandboxExecutor;

    try {
      const bridge = await createSandboxBridge({
        config: {
          profile: restrictiveProfile(),
          buildCommand: createSandboxCommand,
        },
      });
      sandboxBridge = bridge;
      forgeExecutor = bridgeToExecutor(bridge);
    } catch {
      process.stderr.write("warn: sandbox unavailable, forged tool execution disabled\n");
      forgeExecutor = {
        execute: async () => ({
          ok: false as const,
          error: {
            code: "PERMISSION" as const,
            message:
              "Sandbox executor not configured — forged tool execution is not available in this CLI session",
            durationMs: 0,
          },
        }),
      };
    }

    forgeBootstrap = createForgeBootstrap({
      executor: forgeExecutor,
      forgeConfig: { enabled: true },
      resolveSessionId: () => currentStartSessionId,
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`warn: forge bootstrap failed: ${msg}\n`);
      },
    });
  } else {
    forgeBootstrap = undefined;
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
    if (sandboxBridge !== undefined) {
      await sandboxBridge.dispose();
    }
    process.exit(EXIT_CONFIG);
  }

  // 6. ASSEMBLE: Use resolved engine or fall back to pi adapter
  const adapter = resolved.value.engine ?? createPiAdapter({ model: manifest.model.name });

  // 6b. Resolve Nexus stack (embed or remote)
  const nexus = await resolveNexusOrWarn(flags.nexusUrl, manifest.nexus?.url, flags.verbose);

  // 6. WIRE: Create the Koi runtime with resolved middleware + context extension
  // Resolve bootstrap sources if configured, then merge with explicit sources
  const contextConfig = await mergeBootstrapContext(manifest.context, manifestPath, manifest.name);
  const contextExt = createContextExtension(contextConfig);
  const extensions = contextExt !== undefined ? [contextExt] : [];

  const { runtime } = await createForgeConfiguredKoi({
    manifest,
    adapter,
    middleware: [
      ...resolved.value.middleware,
      ...nexus.middlewares,
      ...(forgeBootstrap?.middlewares ?? []),
    ],
    providers: [
      ...nexus.providers,
      ...(forgeBootstrap !== undefined
        ? [forgeBootstrap.provider, forgeBootstrap.forgeToolsProvider]
        : []),
    ],
    extensions,
    ...(forgeBootstrap !== undefined ? { forge: forgeBootstrap.runtime } : {}),
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

  // let justified: conditionally set when --temporal-url, disposed at cleanup
  let temporalAdmin: Awaited<ReturnType<typeof resolveTemporalOrWarn>>;

  if (flags.admin) {
    try {
      const channelNames = channels.map((ch) => ch.name);
      const skillNames = (manifest.skills ?? []).map((s) => s.name);

      const { dirname: pathDirname, resolve: pathResolve } = await import("node:path");
      const workspaceRoot = pathResolve(pathDirname(manifestPath));

      temporalAdmin = await resolveTemporalOrWarn(flags.temporalUrl, flags.verbose);

      adminBridge = createAdminPanelBridge({
        agentName: manifest.name,
        agentType: manifest.lifecycle ?? "copilot",
        model: modelName,
        channels: channelNames,
        skills: skillNames,
        fileSystem: createLocalFileSystem(workspaceRoot),
        ...(temporalAdmin !== undefined
          ? {
              orchestration: { temporal: temporalAdmin.views },
              orchestrationCommands: temporalAdmin.commands,
            }
          : {}),
      });

      const assetsDir = resolveDashboardAssetsDir();
      const dashboardResult: DashboardHandlerResult = createDashboardHandler(adminBridge, {
        cors: true,
        ...(assetsDir !== undefined ? { assetsDir } : {}),
      });

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

      process.stderr.write(`Admin panel: http://localhost:${String(server.port)}\n`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`warn: admin panel failed to start: ${message}\n`);
    }
  }

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
        for await (const event of runtime.run(input)) {
          if (controller.signal.aborted) break;
          renderEvent(event, flags.verbose);
          if (event.kind === "done" && adminBridge !== undefined) {
            const m = event.output.metrics;
            adminBridge.updateMetrics({ turns: m.turns, totalTokens: m.totalTokens });
          }
        }
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
  if (temporalAdmin !== undefined) {
    await temporalAdmin.dispose();
  }
  await runtime.dispose();
  forgeBootstrap?.dispose();
  if (sandboxBridge !== undefined) {
    await sandboxBridge.dispose();
  }
  if (nexus.dispose !== undefined) {
    await nexus.dispose();
  }

  process.stderr.write("Goodbye.\n");
}
