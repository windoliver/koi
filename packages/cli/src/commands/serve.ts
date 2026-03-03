/**
 * `koi serve` command — headless agent runner for background service use.
 *
 * Like `koi start` but:
 * - No REPL/stdin interaction
 * - Starts HTTP health server
 * - Uses @koi/shutdown for graceful signal handling
 * - Uses exit codes from @koi/shutdown (78 for config, 1 for runtime)
 */

import { createContextExtension } from "@koi/context";
import type { ContentBlock, EngineInput } from "@koi/core";
import { createHealthServer } from "@koi/deploy";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { loadManifest } from "@koi/manifest";
import { createShutdownHandler, EXIT_CONFIG, EXIT_ERROR } from "@koi/shutdown";
import type { ServeFlags } from "../args.js";
import { formatResolutionError, resolveAgent } from "../resolve-agent.js";
import { mergeBootstrapContext } from "../resolve-bootstrap.js";

// ---------------------------------------------------------------------------
// Text extraction helper
// ---------------------------------------------------------------------------

function extractTextFromBlocks(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text")
    .map((b) => b.text)
    .join("\n");
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

  // 4. RESOLVE: Resolve manifest into runtime instances (middleware + model)
  const modelName = manifest.model.name;
  const resolved = await resolveAgent({ manifestPath, manifest });
  if (!resolved.ok) {
    process.stderr.write(formatResolutionError(resolved.error));
    process.exit(EXIT_CONFIG);
  }

  // 5. ASSEMBLE: Use resolved engine or fall back to loop adapter
  const adapter = resolved.value.engine ?? createLoopAdapter({ modelCall: resolved.value.model });

  // 6. WIRE: Create the Koi runtime with resolved middleware + context extension
  // Resolve bootstrap sources if configured, then merge with explicit sources
  const contextConfig = await mergeBootstrapContext(manifest.context, manifestPath, manifest.name);
  const contextExt = createContextExtension(contextConfig);
  const extensions = contextExt !== undefined ? [contextExt] : [];

  const runtime = await createKoi({
    manifest,
    adapter,
    middleware: resolved.value.middleware,
    extensions,
  });

  // 6b. Connect resolved channels and wire 1:1 response routing
  // Empty fallback is intentional — headless serve mode has no stdin/stdout channel
  const channels = resolved.value.channels ?? [];
  for (const ch of channels) {
    await ch.connect();
  }

  const unsubscribers = channels.map((ch) =>
    ch.onMessage(async (inbound) => {
      const text = extractTextFromBlocks(inbound.content);
      if (text.trim() === "") return;

      const input: EngineInput = { kind: "text", text };
      const blocks: ContentBlock[] = [];

      try {
        for await (const event of runtime.run(input)) {
          if (event.kind === "text_delta") {
            blocks.push({ kind: "text", text: event.delta });
          }
        }

        if (blocks.length > 0) {
          await ch.send({ content: blocks });
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Channel "${ch.name}" error: ${message}\n`);
      }
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
        for (const unsub of unsubscribers) {
          unsub();
        }
        for (const ch of channels) {
          await ch.disconnect();
        }
        healthServer.stop();
        await runtime.dispose();
      },
    },
    (type) => {
      if (flags.verbose) {
        process.stderr.write(`[shutdown] ${type}\n`);
      }
    },
  );

  shutdown.install();

  // 8. Print startup info
  if (flags.verbose) {
    process.stderr.write(`Agent: ${manifest.name} v${manifest.version}\n`);
    process.stderr.write(`Model: ${modelName}\n`);
    process.stderr.write(`Health: ${healthInfo.url}\n`);
  }

  process.stderr.write(
    `Agent "${manifest.name}" serving on port ${healthInfo.port}. Send SIGTERM to stop.\n`,
  );

  // 9. Wait for abort signal (blocks until shutdown)
  await new Promise<void>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(), { once: true });
  });

  shutdown.uninstall();
  process.stderr.write("Goodbye.\n");
}
