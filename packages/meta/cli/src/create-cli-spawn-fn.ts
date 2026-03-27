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
  EngineEvent,
  EngineOutput,
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
// Output extraction helpers
// ---------------------------------------------------------------------------

/** Extract text from done.output.content blocks (standard engine adapters). */
function extractTextFromContent(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if ("text" in block && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/** Extract error details from done.output.metadata (PI adapter pattern). */
function extractErrorMessage(output: EngineOutput): string {
  const meta = output.metadata;
  if (typeof meta === "object" && meta !== null && "error" in meta) {
    return String(meta.error);
  }
  if (typeof meta === "object" && meta !== null && "errorMessage" in meta) {
    return String(meta.errorMessage);
  }
  return "Child agent terminated with error";
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
        // Run the child with the task description as text input.
        // Accumulate text_delta events (PI adapter delivers text this way;
        // done.output.content is empty for PI). Also capture done.output
        // for content blocks and stopReason checking.
        const textDeltas: string[] = [];
        let doneOutput: EngineOutput | undefined;

        for await (const event of childRuntime.run({ kind: "text", text: request.description })) {
          if (request.signal.aborted) {
            break;
          }
          if (event.kind === "text_delta") {
            textDeltas.push((event as EngineEvent & { readonly delta: string }).delta);
          }
          if (event.kind === "done") {
            doneOutput = event.output;
          }
        }

        if (request.signal.aborted) {
          return {
            ok: false,
            error: { code: "EXTERNAL", message: "Spawn aborted", retryable: false },
          };
        }

        // Check stopReason before treating as success — errored runs must
        // be reported as failures, not silently swallowed.
        if (doneOutput?.stopReason === "error") {
          return {
            ok: false,
            error: {
              code: "EXTERNAL",
              message: extractErrorMessage(doneOutput),
              retryable: true,
            },
          };
        }

        // Prefer text_delta accumulation (PI adapter), fall back to
        // done.output.content blocks (standard adapters).
        const deltaText = textDeltas.join("");
        const contentText =
          doneOutput !== undefined ? extractTextFromContent(doneOutput.content) : "";
        const outputText = deltaText.length > 0 ? deltaText : contentText;

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
