/**
 * createCliSpawnFn — build a SpawnFn from CLI runtime context.
 *
 * Wraps `spawnChildAgent` from @koi/engine into the SpawnFn contract
 * expected by the delegation bridge. Each spawn creates a new child agent,
 * runs it with the task description as input, and collects the output.
 *
 * The child inherits the parent's adapter but gets its own runtime,
 * process slot (via spawn ledger), and lifecycle tracking (via registry).
 */

import type {
  AgentManifest,
  ContentBlock,
  EngineAdapter,
  KoiError,
  SpawnFn,
  SpawnRequest,
  SpawnResult,
} from "@koi/core";
import type { KoiRuntime } from "@koi/engine";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CliSpawnFnConfig {
  /** The parent agent's runtime — used for parentAgent reference. */
  readonly runtime: KoiRuntime;
  /** Engine adapter factory — reused for child agents. */
  readonly adapter: EngineAdapter;
  /** Maximum concurrent child agents (spawn ledger slots). */
  readonly maxConcurrent?: number | undefined;
}

// ---------------------------------------------------------------------------
// Content extraction helper
// ---------------------------------------------------------------------------

function extractTextFromContent(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if ("text" in block && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CONCURRENT = 5;

export async function createCliSpawnFn(config: CliSpawnFnConfig): Promise<SpawnFn> {
  const { createInMemorySpawnLedger, spawnChildAgent } = await import("@koi/engine");

  const ledger = createInMemorySpawnLedger(config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);

  const spawn: SpawnFn = async (request: SpawnRequest): Promise<SpawnResult> => {
    // Build a minimal child manifest from the request.
    // If the request includes an inline manifest, use it directly.
    // Otherwise, create a minimal manifest from agentName.
    const childManifest: AgentManifest = request.manifest ?? {
      name: request.agentName,
      version: "0.1.0",
      model: config.runtime.agent.manifest.model,
    };

    try {
      const { runtime: childRuntime } = await spawnChildAgent({
        manifest: childManifest,
        adapter: config.adapter,
        parentAgent: config.runtime.agent,
        spawnLedger: ledger,
        spawnPolicy: { maxDepth: 3, maxFanOut: 5, maxTotalProcesses: 10 },
      });

      try {
        // Run the child with the task description as text input
        let outputText = "";
        for await (const event of childRuntime.run({ kind: "text", text: request.description })) {
          if (request.signal.aborted) {
            break;
          }
          if (event.kind === "done") {
            outputText = extractTextFromContent(event.output.content);
          }
        }

        if (request.signal.aborted) {
          return {
            ok: false,
            error: { code: "EXTERNAL", message: "Spawn aborted", retryable: false },
          };
        }

        return { ok: true, output: outputText || "(no output)" };
      } finally {
        await childRuntime.dispose();
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      const error: KoiError = {
        code: "EXTERNAL",
        message: `Spawn failed for ${request.agentName}: ${message}`,
        retryable: true,
      };
      return { ok: false, error };
    }
  };

  return spawn;
}
