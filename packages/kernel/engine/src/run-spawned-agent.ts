/**
 * runSpawnedAgent — shared spawn lifecycle for hook and general agent spawns.
 *
 * Handles: spawnChildAgent → optional hooks → run to completion → collect → cleanup.
 * Both createHookSpawnFn and createAgentSpawnFn compose this helper.
 */

import type { CapabilityFragment, EngineInput, KoiMiddleware, SpawnResult } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";

import type { OutputCollector } from "./output-collector.js";
import { spawnChildAgent } from "./spawn-child.js";
import { markPreAdmission, stripPreAdmission } from "./spawn-pre-admission.js";
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

  // spawnChildAgent() covers slot acquisition, governance, and assembly —
  // everything BEFORE the child process actually runs. Failures here are
  // pre-admission and should refund the parent's per-turn fan-out budget
  // via the spawn-pre-admission marker (#1793). Failures after this point
  // (runtime.run) are post-admission and must keep consuming budget.
  let runtime: Awaited<ReturnType<typeof spawnChildAgent>>["runtime"];
  let handle: Awaited<ReturnType<typeof spawnChildAgent>>["handle"];
  try {
    ({ runtime, handle } = await spawnChildAgent(spawnOptions));
  } catch (e: unknown) {
    if (e instanceof KoiRuntimeError) {
      return { ok: false, error: markPreAdmission(e.toKoiError()) };
    }
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: markPreAdmission({
        code: "INTERNAL",
        message: `Spawn failed: ${message}`,
        retryable: false,
      }),
    };
  }

  const childSessionId = runtime.sessionId;
  onBeforeRun?.(childSessionId);

  try {
    for await (const event of runtime.run(input)) {
      collector.observe(event);
    }
    return { ok: true, output: collector.output() };
  } catch (e: unknown) {
    // Post-admission: the child was successfully assembled and started
    // running. Preserve structured KoiError fields but strip any
    // `context.preAdmission` marker a child may have forged — the
    // parent's spawn guard treats that flag as authoritative, so
    // allowing it to cross the child→parent boundary would let a
    // malicious or buggy child refund the parent's per-turn fan-out
    // budget and bypass the cap (#1793).
    if (e instanceof KoiRuntimeError) {
      return { ok: false, error: stripPreAdmission(e.toKoiError()) };
    }
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: `Spawned agent failed: ${message}`,
        retryable: false,
      },
    };
  } finally {
    onAfterRun?.(childSessionId);
    // Terminate via handle first (releases ledger + revokes delegation
    // in registry-backed spawns), then dispose the runtime.
    handle.terminate();
    await handle.waitForCompletion();
    await runtime.dispose();
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
    async wrapModelCall(ctx, request, next) {
      ctx.reportDecision?.({
        action: "inject",
        promptLength: prompt.length,
        preview: prompt.slice(0, 200),
      });
      return next({
        ...request,
        systemPrompt: mergeSystemPrompt(prompt, request.systemPrompt),
      });
    },
    async *wrapModelStream(ctx, request, next) {
      ctx.reportDecision?.({
        action: "inject",
        promptLength: prompt.length,
        preview: prompt.slice(0, 200),
      });
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
