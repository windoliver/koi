/**
 * `koi start` command — loads a koi.yaml manifest and runs the agent.
 *
 * Bootstrap sequence:
 * 1. RESOLVE:  Find manifest file (--manifest flag, positional arg, or default ./koi.yaml)
 * 2. VALIDATE: loadManifest() from @koi/manifest
 * 3. ASSEMBLE: Create EngineAdapter (engine-loop) with model terminal
 * 4. WIRE:     createKoi() from @koi/engine with middleware + providers
 * 5. START:    runtime.run() — async iterate events
 * 6. RENDER:   Write events to stdout/stderr
 * 7. SHUTDOWN: AbortController + SIGINT/SIGTERM handlers
 */

import { createCliChannel } from "@koi/channel-cli";
import { createContextExtension } from "@koi/context";
import type { ChannelAdapter, ContentBlock, EngineEvent, EngineInput } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { getEngineName, loadManifest } from "@koi/manifest";
import { EXIT_CONFIG } from "@koi/shutdown";
import type { StartFlags } from "../args.js";
import { formatResolutionError, resolveAgent } from "../resolve-agent.js";
import { mergeBootstrapContext } from "../resolve-bootstrap.js";

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
      // Internal events — no user-visible output
      break;
  }
}

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

  // 4. RESOLVE: Resolve manifest into runtime instances (middleware + model)
  const modelName = manifest.model.name;
  const resolved = await resolveAgent({ manifestPath, manifest });
  if (!resolved.ok) {
    process.stderr.write(formatResolutionError(resolved.error));
    process.exit(EXIT_CONFIG);
  }

  // 5. ASSEMBLE: Use resolved engine or fall back to pi adapter
  const adapter = resolved.value.engine ?? createPiAdapter({ model: manifest.model.name });

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

  // 6b. Set up channels — use resolved channels or fall back to CLI channel
  const channels: readonly ChannelAdapter[] = resolved.value.channels ?? [createCliChannel()];
  for (const ch of channels) {
    await ch.connect();
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
      const input: EngineInput = { kind: "text", text };

      try {
        for await (const event of runtime.run(input)) {
          if (controller.signal.aborted) break;
          renderEvent(event, flags.verbose);
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
  await runtime.dispose();

  process.stderr.write("Goodbye.\n");
}
