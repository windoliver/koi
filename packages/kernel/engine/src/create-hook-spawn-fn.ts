/**
 * createHookSpawnFn — adapter from L0 SpawnFn to L1 spawnChildAgent.
 *
 * Maps SpawnRequest fields to SpawnChildOptions for hook-agent spawns.
 * The returned SpawnFn is passed to `createHookMiddleware({ spawnFn })`.
 *
 * Lifecycle is delegated to runSpawnedAgent (shared with createAgentSpawnFn).
 */

import type {
  AgentManifest,
  EngineAdapter,
  KoiMiddleware,
  SpawnFn,
  SpawnRequest,
  SpawnResult,
} from "@koi/core";
import { createVerdictCollector } from "./output-collector.js";
import { createSystemPromptMiddleware, runSpawnedAgent } from "./run-spawned-agent.js";
import type { SpawnChildOptions } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Minimal interface for hook-agent session marking.
 * Matches the relevant subset of HookRegistry from @koi/hooks.
 * Defined here to avoid L1→L2 import.
 */
export interface HookAgentMarker {
  readonly markHookAgent: (sessionId: string) => void;
  readonly unmarkHookAgent: (sessionId: string) => void;
}

/** Options for creating a hook-agent SpawnFn. */
export interface CreateHookSpawnFnOptions {
  /**
   * Base options shared across all hook-agent spawns.
   * Must include parentAgent, spawnLedger, spawnPolicy, adapter.
   */
  readonly base: Omit<
    SpawnChildOptions,
    | "manifest"
    | "toolDenylist"
    | "additionalTools"
    | "nonInteractive"
    | "requiredOutputTool"
    | "limits"
    | "providers"
    | "middleware"
  >;
  /** Engine adapter factory or shared adapter for hook agents. */
  readonly adapter: EngineAdapter;
  /** Base manifest template for hook agents. Overridden per-request. */
  readonly manifestTemplate: AgentManifest;
  /**
   * Parent middleware to inherit into hook agents. Typically includes
   * observe-phase middleware (tracing, telemetry, audit) that should
   * see hook agent activity. Intercept/resolve-phase middleware (hooks,
   * permissions) should NOT be included — hook agents are isolated.
   */
  readonly inheritedMiddleware?: readonly KoiMiddleware[] | undefined;
  /**
   * Hook registry marker for recursion prevention. When provided,
   * the child session is marked as a hook agent before running and
   * unmarked after completion. This suppresses hook dispatch for the
   * child session at the registry level.
   */
  readonly hookAgentMarker?: HookAgentMarker | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a SpawnFn that spawns hook-agent sub-agents via runSpawnedAgent.
 *
 * Maps SpawnRequest sub-agent constraint fields to SpawnChildOptions:
 * - `toolDenylist` → filters inherited tools
 * - `additionalTools` → injected via component provider
 * - `maxTurns` → mapped to `limits.maxTurns`
 * - `maxTokens` → mapped to `limits.maxTokens`
 * - `nonInteractive` → passed through
 */
export function createHookSpawnFn(options: CreateHookSpawnFnOptions): SpawnFn {
  const { base, adapter, manifestTemplate, inheritedMiddleware, hookAgentMarker } = options;

  return async (request: SpawnRequest): Promise<SpawnResult> => {
    // Build manifest for this hook agent
    const manifest: AgentManifest = {
      ...manifestTemplate,
      name: request.agentName,
      description: request.description,
    };

    // Use explicit required output tool name from the request.
    // Falls back to additionalTools[0] for backward compat, but callers
    // should always set requiredOutputToolName explicitly.
    const requiredOutputTool =
      request.requiredOutputToolName ??
      (request.outputSchema !== undefined && request.additionalTools !== undefined
        ? request.additionalTools[0]?.name
        : undefined);

    // Build middleware list: inherited (tracing) + system prompt injection
    const childMiddleware: KoiMiddleware[] = [...(inheritedMiddleware ?? [])];
    if (request.systemPrompt !== undefined) {
      childMiddleware.push(createSystemPromptMiddleware(request.systemPrompt));
    }

    // Map SpawnRequest constraint fields to SpawnChildOptions
    const spawnOptions: SpawnChildOptions = {
      ...base,
      manifest,
      adapter,
      ...(request.toolDenylist !== undefined ? { toolDenylist: request.toolDenylist } : {}),
      ...(request.additionalTools !== undefined
        ? { additionalTools: request.additionalTools }
        : {}),
      ...(request.nonInteractive !== undefined ? { nonInteractive: request.nonInteractive } : {}),
      ...(requiredOutputTool !== undefined ? { requiredOutputTool } : {}),
      ...(childMiddleware.length > 0 ? { middleware: childMiddleware } : {}),
      limits: {
        ...(request.maxTurns !== undefined ? { maxTurns: request.maxTurns } : {}),
        ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
      },
    };

    return runSpawnedAgent({
      spawnOptions,
      input: { kind: "text", text: request.description, signal: request.signal },
      collector: createVerdictCollector(requiredOutputTool),
      ...(hookAgentMarker
        ? {
            onBeforeRun: hookAgentMarker.markHookAgent,
            onAfterRun: hookAgentMarker.unmarkHookAgent,
          }
        : {}),
    });
  };
}
