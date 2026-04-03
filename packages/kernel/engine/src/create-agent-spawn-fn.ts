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
  EngineInput,
  InboxItem,
  KoiMiddleware,
  ReportStore,
  SpawnFn,
  SpawnRequest,
  SpawnResult,
  TaskableAgent,
} from "@koi/core";
import { INBOX } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import { runWithAgentContext } from "@koi/execution-context";

import { applyDeliveryPolicy, resolveDeliveryPolicy } from "./delivery-policy.js";
import { createTextCollector } from "./output-collector.js";
import { createSystemPromptMiddleware, runSpawnedAgent } from "./run-spawned-agent.js";
import { spawnChildAgent } from "./spawn-child.js";
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
  /**
   * ReportStore for on_demand delivery. Required when spawning agents with
   * `delivery.kind === "on_demand"` — fail-fast if absent to prevent silent drops.
   */
  readonly reportStore?: ReportStore | undefined;
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

    // 6. Resolve delivery policy: request override > base default > manifest > streaming
    const policy = resolveDeliveryPolicy(request.delivery ?? base.delivery, manifest.delivery);

    // 7. Wrap in agent context for identity isolation
    const agentContext = {
      agentId: request.agentId ?? `spawn-${manifest.name}-${Date.now()}`,
      sessionId: `session-${manifest.name}-${Date.now()}`,
      parentAgentId: base.parentAgent.pid.id,
    };

    // 8a. Non-streaming delivery (deferred / on_demand): spawn child and fire-and-forget.
    //     The real output flows to the parent's inbox or ReportStore per policy.
    //     Return immediately — the SpawnResult output will be empty for async delivery.
    if (policy.kind !== "streaming") {
      // Fail fast: non-streaming delivery requires a sink for the result.
      // on_demand needs a ReportStore; deferred needs the parent inbox.
      // Without the appropriate sink the child runs but output is silently lost.
      if (policy.kind === "on_demand" && options.reportStore === undefined) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message:
              "on_demand delivery requires a ReportStore — provide it via CreateAgentSpawnFnOptions.reportStore",
            retryable: false,
          },
        };
      }
      if (policy.kind === "deferred" && base.parentAgent.component(INBOX) === undefined) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message:
              "deferred delivery requires a parent inbox — the parent agent must have an INBOX component",
            retryable: false,
          },
        };
      }
      return runWithAgentContext(agentContext, async (): Promise<SpawnResult> => {
        // Wrap spawnChildAgent() so slot-acquisition, governance, assembly, and
        // cancellation failures all return SpawnResult instead of throwing.
        // This matches the contract of runSpawnedAgent() used in the streaming path.
        let spawnResult: Awaited<ReturnType<typeof spawnChildAgent>>;
        try {
          spawnResult = await spawnChildAgent(spawnOptions);
        } catch (e: unknown) {
          if (e instanceof KoiRuntimeError) {
            return { ok: false, error: e.toKoiError() };
          }
          const message = e instanceof Error ? e.message : String(e);
          return {
            ok: false,
            error: { code: "INTERNAL", message: `Spawn failed: ${message}`, retryable: false },
          };
        }
        const parentInbox = base.parentAgent.component(INBOX);
        const deliveryHandle = applyDeliveryPolicy({
          spawnResult,
          policy,
          ...(parentInbox !== undefined ? { parentInbox } : {}),
          ...(options.reportStore !== undefined ? { reportStore: options.reportStore } : {}),
          parentAgentId: base.parentAgent.pid.id,
        });
        const input: EngineInput = {
          kind: "text",
          text: request.description,
          signal: request.signal,
        };
        void (async (): Promise<void> => {
          try {
            await deliveryHandle.runChild?.(input);
          } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            console.error(
              `[agent-spawn] ${policy.kind} delivery failed for "${manifest.name}"`,
              err,
            );
            // Propagate delivery failure to parent inbox so the caller can observe it
            // instead of silently discarding the error. The item mode "collect" allows
            // the parent to inspect it at its next turn boundary.
            if (parentInbox !== undefined) {
              const errorItem: InboxItem = {
                id: `delivery-error-${spawnResult.childPid.id}-${Date.now()}`,
                from: spawnResult.childPid.id,
                mode: "collect",
                content: `[delivery-error] agent "${manifest.name}" (${policy.kind}): ${errorMessage}`,
                priority: 0,
                createdAt: Date.now(),
              };
              parentInbox.push(errorItem);
            }
          } finally {
            spawnResult.handle.terminate();
            await spawnResult.handle.waitForCompletion();
            await spawnResult.runtime.dispose();
          }
        })();
        return { ok: true, output: "" };
      });
    }

    // 8b. Streaming (default): run synchronously, collect output inline.
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
