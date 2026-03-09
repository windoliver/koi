/**
 * `koi serve` command — headless agent runner for background service use.
 *
 * Like `koi start` but:
 * - No REPL/stdin interaction
 * - Starts HTTP health server
 * - Uses @koi/shutdown for graceful signal handling
 * - Uses exit codes from @koi/shutdown (78 for config, 1 for runtime)
 * - Conversation persistence via @koi/context-arena + in-memory ThreadStore
 * - Per-session concurrency lanes via @koi/session-state
 */

import { createContextExtension } from "@koi/context";
import { createContextArena } from "@koi/context-arena";
import type {
  ComponentProvider,
  ContentBlock,
  EngineInput,
  InboundMessage,
  KoiMiddleware,
} from "@koi/core";
import { sessionId } from "@koi/core";
import { createHealthServer } from "@koi/deploy";
import { createPiAdapter } from "@koi/engine-pi";
import { createForgeBootstrap, createForgeConfiguredKoi } from "@koi/forge";
import { loadManifest } from "@koi/manifest";
import { createShutdownHandler, EXIT_CONFIG, EXIT_ERROR } from "@koi/shutdown";
import { createInMemorySnapshotChainStore, createThreadStore } from "@koi/snapshot-chain-store";
import type { ServeFlags } from "../args.js";
import { extractTextFromBlocks } from "../helpers.js";
import { formatResolutionError, resolveAgent } from "../resolve-agent.js";
import { mergeBootstrapContext } from "../resolve-bootstrap.js";
import { resolveNexusOrWarn } from "../resolve-nexus.js";

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
// Session key derivation
// ---------------------------------------------------------------------------

/**
 * Derives a stable session key from an inbound message for per-session
 * concurrency lanes and conversation threading.
 *
 * Format: `channel:senderId:threadId` (threadId defaults to "default").
 */
function deriveSessionKey(channelName: string, inbound: InboundMessage): string {
  const thread = inbound.threadId ?? "default";
  return `${channelName}:${inbound.senderId}:${thread}`;
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function runServe(flags: ServeFlags): Promise<void> {
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

  // 3. Resolve health port
  const deployConfig = manifest.deploy;
  const healthPort = flags.port ?? deployConfig?.port ?? 9100;

  // 4. Bootstrap forge system (before resolution, so forgeStore is available)
  // Rejecting executor — forged bricks fail loudly instead of returning silent undefined.
  const rejectingExecutor = {
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
  const forgeBootstrap = createForgeBootstrap({
    executor: rejectingExecutor,
    forgeConfig: { enabled: isForgeEnabled(manifest) },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`warn: forge bootstrap failed: ${msg}\n`);
    },
  });

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

  // 6b. Wire conversation persistence via context-arena (graceful fallback)
  // let justified: message buffer for squash partitioning, cleared per-session
  let currentMessages: readonly InboundMessage[] = [];
  // let justified: set inside try/catch, read when building runtime middleware/providers
  let arenaMiddleware: readonly KoiMiddleware[] = [];
  let arenaProviders: readonly ComponentProvider[] = [];

  // let justified: mutable binding updated per-message so resolveThreadId can read the
  // current session key. Updated inside the serial queue before each runtime.run() call.
  let currentThreadKey: string | undefined;

  try {
    const threadStore = createThreadStore({
      store: createInMemorySnapshotChainStore(),
    });

    // TODO(#2): Single synthetic sessionId means all threads share the same
    // squash/compaction archive namespace. Per-thread archive isolation requires
    // squash/compactor APIs to accept a sessionId resolver function.
    const arenaBundle = await createContextArena({
      summarizer: resolved.value.model,
      sessionId: sessionId(`serve:${manifest.name}:${Date.now()}`),
      getMessages: () => currentMessages,
      threadStore,
      conversation: {
        resolveThreadId: () => currentThreadKey,
      },
    });

    arenaMiddleware = arenaBundle.middleware;
    arenaProviders = arenaBundle.providers;

    if (flags.verbose) {
      process.stderr.write(
        `Conversation persistence: enabled (${String(arenaBundle.middleware.length)} middleware)\n`,
      );
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`warn: conversation persistence disabled: ${message}\n`);
  }

  const { runtime } = await createForgeConfiguredKoi({
    manifest,
    adapter,
    middleware: [
      ...resolved.value.middleware,
      ...arenaMiddleware,
      ...nexus.middlewares,
      ...(forgeBootstrap?.middlewares ?? []),
    ],
    providers: [
      ...nexus.providers,
      ...arenaProviders,
      ...(forgeBootstrap !== undefined ? [forgeBootstrap.provider] : []),
    ],
    extensions,
    ...(forgeBootstrap !== undefined ? { forge: forgeBootstrap.runtime } : {}),
  });

  // 6c. Connect resolved channels and wire per-session concurrency
  // Empty fallback is intentional — headless serve mode has no stdin/stdout channel
  const channels = resolved.value.channels ?? [];
  for (const ch of channels) {
    await ch.connect();
  }

  // Global serial queue — runtime enforces single-flight (throws on concurrent
  // run() calls), so all messages serialize through one queue.
  // let justified: serial queue prevents concurrent runtime.run() calls
  let pending: Promise<void> = Promise.resolve();

  const unsubscribers = channels.map((ch) =>
    ch.onMessage(async (inbound) => {
      const text = extractTextFromBlocks(inbound.content);
      if (text.trim() === "") return;

      const key = deriveSessionKey(ch.name, inbound);

      pending = pending.then(async () => {
        // Update bindings for conversation middleware and squash partitioning
        currentMessages = [inbound];
        currentThreadKey = key;

        const input: EngineInput = { kind: "text", text };

        try {
          // Collect text deltas into local array, build immutable blocks at end
          const deltas: string[] = [];
          for await (const event of runtime.run(input)) {
            if (event.kind === "text_delta") {
              deltas.push(event.delta);
            }
          }

          if (deltas.length > 0) {
            const blocks: readonly ContentBlock[] = deltas.map((d) => ({
              kind: "text" as const,
              text: d,
            }));
            await ch.send({ content: blocks });
          }
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          process.stderr.write(`Channel "${ch.name}" session "${key}" error: ${msg}\n`);
        } finally {
          currentMessages = [];
          currentThreadKey = undefined;
        }
      });

      await pending;
    }),
  );

  // 7. Start health server
  const healthServer = createHealthServer({
    port: healthPort,
    onReady: () => true, // Agent is ready once serve starts
  });

  let healthInfo: { readonly url: string; readonly port: number };
  try {
    healthInfo = await healthServer.start();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Failed to start health server: ${message}\n`);
    await runtime.dispose();
    process.exit(EXIT_ERROR);
    return; // unreachable but satisfies TypeScript
  }

  // 8. Set up graceful shutdown
  const controller = new AbortController();

  const shutdown = createShutdownHandler(
    {
      onStopAccepting() {
        controller.abort();
      },
      async onDrainAgents() {
        // Give the runtime a moment to finish current work
      },
      async onCleanup() {
        // Cleanup is done explicitly after the abort signal below
      },
    },
    (type) => {
      if (flags.verbose) {
        process.stderr.write(`[shutdown] ${type}\n`);
      }
    },
  );

  shutdown.install();

  // 9. Print startup info
  if (flags.verbose) {
    process.stderr.write(`Agent: ${manifest.name} v${manifest.version}\n`);
    process.stderr.write(`Model: ${modelName}\n`);
    process.stderr.write(`Health: ${healthInfo.url}\n`);
  }

  process.stderr.write(
    `Agent "${manifest.name}" serving on port ${healthInfo.port}. Send SIGTERM to stop.\n`,
  );

  // 10. Wait for abort signal (blocks until shutdown)
  await new Promise<void>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(), { once: true });
  });

  // 11. Cleanup — stop accepting new messages first, then drain in-flight work
  shutdown.uninstall();
  for (const unsub of unsubscribers) {
    unsub();
  }
  await pending;
  for (const ch of channels) {
    await ch.disconnect();
  }
  healthServer.stop();
  await runtime.dispose();
  forgeBootstrap?.dispose();
  if (nexus.dispose !== undefined) {
    await nexus.dispose();
  }

  process.stderr.write("Goodbye.\n");
}
