/**
 * runSpawnedAgent — shared spawn lifecycle for hook and general agent spawns.
 *
 * Handles: spawnChildAgent → optional hooks → run to completion → collect → cleanup.
 * Both createHookSpawnFn and createAgentSpawnFn compose this helper.
 */

import type { CapabilityFragment, EngineInput, KoiMiddleware, SpawnResult } from "@koi/core";
import type { OutputCollector } from "./output-collector.js";
import { spawnChildAgent } from "./spawn-child.js";
import type { SpawnChildOptions } from "./types.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RunSpawnedAgentOptions {
  /** Fully-built spawn options (manifest, adapter, tools, limits, etc.). */
  readonly spawnOptions: SpawnChildOptions;
  /** Engine input for the spawned agent (text prompt + signal). */
  readonly input: EngineInput;
  /** Output collector that observes engine events. */
  readonly collector: OutputCollector;
  /** Optional pre-run hook (e.g., mark hook agent). Called with session ID. */
  readonly onBeforeRun?: (sessionId: string) => void;
  /** Optional post-run hook (e.g., unmark hook agent). Called in finally. */
  readonly onAfterRun?: (sessionId: string) => void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Spawn a child agent, run it to completion, collect output, and clean up.
 *
 * Lifecycle:
 * 1. spawnChildAgent() — acquires ledger slot, creates runtime
 * 2. onBeforeRun?.(sessionId)
 * 3. Iterate runtime.run(input) — collector observes events
 * 4. finally: onAfterRun, handle.terminate, waitForCompletion, dispose
 * 5. Return SpawnResult with collected output
 */
export async function runSpawnedAgent(options: RunSpawnedAgentOptions): Promise<SpawnResult> {
  const { spawnOptions, input, collector, onBeforeRun, onAfterRun } = options;

  try {
    const { runtime, handle } = await spawnChildAgent(spawnOptions);
    const childSessionId = runtime.sessionId;

    onBeforeRun?.(childSessionId);

    try {
      for await (const event of runtime.run(input)) {
        collector.observe(event);
      }

      return { ok: true, output: collector.output() };
    } finally {
      onAfterRun?.(childSessionId);
      // Terminate via handle first (releases ledger + revokes delegation
      // in registry-backed spawns), then dispose the runtime.
      handle.terminate();
      await handle.waitForCompletion();
      await runtime.dispose();
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: `Spawned agent failed: ${message}`,
        retryable: false,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Shared middleware: system prompt injection
// ---------------------------------------------------------------------------

/**
 * Creates a middleware that injects a system prompt into every model call.
 * Prepends the prompt to any existing systemPrompt (e.g., from the
 * structured output guard's re-prompt hint) rather than replacing it.
 */
export function createSystemPromptMiddleware(prompt: string): KoiMiddleware {
  return {
    name: "spawned-agent:system-prompt",
    phase: "resolve",
    priority: 100,
    async wrapModelCall(_ctx, request, next) {
      return next({
        ...request,
        systemPrompt: mergeSystemPrompt(prompt, request.systemPrompt),
      });
    },
    async *wrapModelStream(_ctx, request, next) {
      yield* next({
        ...request,
        systemPrompt: mergeSystemPrompt(prompt, request.systemPrompt),
      });
    },
    describeCapabilities(): CapabilityFragment | undefined {
      return undefined;
    },
  };
}

/** Prepend prompt to existing systemPrompt, preserving guard hints. */
function mergeSystemPrompt(prompt: string, existing: string | undefined): string {
  if (existing === undefined || existing.length === 0) return prompt;
  return `${prompt}\n\n${existing}`;
}
