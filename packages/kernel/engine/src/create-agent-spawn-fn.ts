/**
 * createAgentSpawnFn — SpawnFn that resolves agents via AgentResolver and spawns in-process.
 *
 * This is the main deliverable for #1424: the glue between L2 agent definitions
 * and L1 spawn machinery. Resolves agent type → AgentDefinition → manifest,
 * injects systemPrompt, and delegates to runSpawnedAgent for lifecycle.
 *
 * Layer: L1 (depends on L0 interfaces only — AgentResolver is L0, implementation is L2)
 */

import type {
  AgentManifest,
  AgentResolver,
  EngineAdapter,
  KoiMiddleware,
  SpawnFn,
  SpawnRequest,
  SpawnResult,
  TaskableAgent,
} from "@koi/core";
import { runWithAgentContext } from "@koi/execution-context";

import { createTextCollector } from "./output-collector.js";
import { createSystemPromptMiddleware, runSpawnedAgent } from "./run-spawned-agent.js";
import type { SpawnChildOptions } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Options for creating an agent-resolution SpawnFn. */
export interface CreateAgentSpawnFnOptions {
  /** Agent resolver for definition lookup (L0 interface, L2 implementation). */
  readonly resolver: AgentResolver;
  /**
   * Base spawn options shared across all agent spawns.
   * Must include parentAgent, spawnLedger, spawnPolicy.
   */
  readonly base: Omit<
    SpawnChildOptions,
    | "manifest"
    | "adapter"
    | "toolDenylist"
    | "additionalTools"
    | "nonInteractive"
    | "requiredOutputTool"
    | "limits"
    | "providers"
    | "middleware"
    | "signal"
  >;
  /** Engine adapter for child agent loops. */
  readonly adapter: EngineAdapter;
  /** Base manifest template — merged with resolved definition. */
  readonly manifestTemplate: AgentManifest;
  /** Inherited middleware (observe-phase: tracing, telemetry). */
  readonly inheritedMiddleware?: readonly KoiMiddleware[] | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a SpawnFn that resolves agents via AgentResolver and spawns them in-process.
 *
 * Flow:
 * 1. Resolve agentName → TaskableAgent (AgentDefinition) via resolver
 * 2. Build manifest from template + definition
 * 3. Inject systemPrompt from definition (if present)
 * 4. Build SpawnChildOptions from SpawnRequest constraints
 * 5. Delegate to runSpawnedAgent for lifecycle
 * 6. Wrap in AgentExecutionContext for identity isolation
 */
export function createAgentSpawnFn(options: CreateAgentSpawnFnOptions): SpawnFn {
  const { resolver, base, adapter, manifestTemplate, inheritedMiddleware } = options;

  return async (request: SpawnRequest): Promise<SpawnResult> => {
    // 1. Resolve agent definition (or use inline manifest)
    let manifest: AgentManifest;
    let systemPrompt: string | undefined = request.systemPrompt;

    if (request.manifest !== undefined) {
      // Inline manifest provided — skip resolution
      manifest = request.manifest;
    } else {
      const resolveResult = await resolver.resolve(request.agentName);
      if (!resolveResult.ok) {
        return { ok: false, error: resolveResult.error };
      }
      const definition = resolveResult.value;

      // 2. Build manifest: template + definition overrides
      manifest = {
        ...manifestTemplate,
        name: definition.name,
        description: definition.description,
        ...(definition.manifest.model !== undefined ? { model: definition.manifest.model } : {}),
      };

      // 3. Use definition's systemPrompt if request didn't provide one
      if (systemPrompt === undefined) {
        systemPrompt = extractSystemPrompt(definition);
      }
    }

    // 4. Build middleware: inherited + system prompt injection
    const childMiddleware: KoiMiddleware[] = [...(inheritedMiddleware ?? [])];
    if (systemPrompt !== undefined) {
      childMiddleware.push(createSystemPromptMiddleware(systemPrompt));
    }

    // 5. Map SpawnRequest constraint fields to SpawnChildOptions
    const spawnOptions: SpawnChildOptions = {
      ...base,
      manifest,
      adapter,
      signal: request.signal,
      ...(request.toolDenylist !== undefined ? { toolDenylist: request.toolDenylist } : {}),
      ...(request.additionalTools !== undefined
        ? { additionalTools: request.additionalTools }
        : {}),
      ...(request.nonInteractive !== undefined ? { nonInteractive: request.nonInteractive } : {}),
      ...(childMiddleware.length > 0 ? { middleware: childMiddleware } : {}),
      limits: {
        ...(request.maxTurns !== undefined ? { maxTurns: request.maxTurns } : {}),
        ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
      },
    };

    // 6. Wrap in agent context for identity isolation
    const agentContext = {
      agentId: request.agentId ?? `spawn-${manifest.name}-${Date.now()}`,
      sessionId: `session-${manifest.name}-${Date.now()}`,
      parentAgentId: base.parentAgent.pid.id,
    };

    return runWithAgentContext(agentContext, () =>
      runSpawnedAgent({
        spawnOptions,
        input: { kind: "text", text: request.description, signal: request.signal },
        collector: createTextCollector(),
      }),
    );
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract systemPrompt from a TaskableAgent if it has one.
 * AgentDefinition extends TaskableAgent with an optional systemPrompt field.
 */
function extractSystemPrompt(agent: TaskableAgent): string | undefined {
  return (agent as { readonly systemPrompt?: string }).systemPrompt;
}
