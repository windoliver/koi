/**
 * `koi serve` command — headless agent runner for background service use.
 *
 * Like `koi start` but:
 * - No REPL/stdin interaction
 * - Starts HTTP health server
 * - Uses @koi/shutdown for graceful signal handling
 * - Uses exit codes from @koi/shutdown (78 for config, 1 for runtime)
 */

import type { ModelHandler, ModelRequest, ModelResponse } from "@koi/core";
import { createHealthServer } from "@koi/deploy";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { loadManifest } from "@koi/manifest";
import { createShutdownHandler, EXIT_CONFIG, EXIT_ERROR } from "@koi/shutdown";
import type { ServeFlags } from "../args.js";

// ---------------------------------------------------------------------------
// Placeholder model terminal (same as start.ts)
// ---------------------------------------------------------------------------

function createEchoModelCall(modelName: string): ModelHandler {
  return async (request: ModelRequest): Promise<ModelResponse> => {
    const inputText = request.messages
      .flatMap((m) => m.content)
      .filter((b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text")
      .map((b) => b.text)
      .join("\n");

    return {
      content: `[echo] ${inputText}`,
      model: modelName,
      usage: { inputTokens: inputText.length, outputTokens: inputText.length + 7 },
    };
  };
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

  // 4. ASSEMBLE: Create engine adapter with placeholder model terminal
  const modelName = manifest.model.name;
  const modelCall = createEchoModelCall(modelName);
  const adapter = createLoopAdapter({ modelCall });

  // 5. WIRE: Create the Koi runtime
  const runtime = await createKoi({ manifest, adapter });

  // 6. Start health server
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

  // 7. Set up graceful shutdown
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
