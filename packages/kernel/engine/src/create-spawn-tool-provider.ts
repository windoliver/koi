/**
 * createSpawnToolProvider — ComponentProvider that registers the Spawn tool at assembly time.
 *
 * When an agent is assembled via createKoi({ providers: [spawnToolProvider] }), this
 * provider's attach() is called with the agent entity. It creates a SpawnFn bound to
 * the agent as parent, wraps it in a Tool, and returns it for registration.
 *
 * Usage:
 *   const provider = createSpawnToolProvider({ resolver, spawnLedger, adapter, manifestTemplate });
 *   const runtime = await createKoi({ manifest, adapter, providers: [provider], spawnLedger });
 *
 * The agent can then call "Spawn" as a tool to delegate tasks to sub-agents.
 *
 * Layer: L1 — imports only L0 types + L0u. No L2 imports.
 */

import type {
  Agent,
  AgentManifest,
  AgentResolver,
  ComponentProvider,
  EngineAdapter,
  JsonObject,
  KoiMiddleware,
  SpawnLedger,
  Tool,
  ToolExecuteOptions,
} from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { DEFAULT_SPAWN_POLICY, type SpawnPolicy } from "@koi/engine-compose";

import { createAgentSpawnFn } from "./create-agent-spawn-fn.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Configuration for the spawn tool provider. */
export interface SpawnToolProviderConfig {
  /** Agent resolver for definition lookup. */
  readonly resolver: AgentResolver;
  /** Shared spawn ledger for the agent tree. */
  readonly spawnLedger: SpawnLedger;
  /** Engine adapter for child agent loops. */
  readonly adapter: EngineAdapter;
  /** Base manifest template for spawned agents. */
  readonly manifestTemplate: AgentManifest;
  /**
   * Spawn governance policy. Defaults to DEFAULT_SPAWN_POLICY.
   * Controls max depth, fan-out, and total processes.
   */
  readonly spawnPolicy?: SpawnPolicy | undefined;
  /**
   * Inherited middleware for child agents (observe-phase: tracing, telemetry).
   * Intercept/resolve-phase middleware should NOT be inherited.
   */
  readonly inheritedMiddleware?: readonly KoiMiddleware[] | undefined;
  /**
   * ReportStore for on_demand delivery. Required when resolved agent manifests
   * use `delivery.kind === "on_demand"`. Without it the spawn function will
   * hard-fail on_demand manifests via the VALIDATION error in createAgentSpawnFn.
   */
  readonly reportStore?: import("@koi/core").ReportStore | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a ComponentProvider that registers a "Spawn" tool in the agent's component set.
 *
 * At agent assembly time (createKoi → AgentEntity.assemble), attach(agent) is called.
 * The assembled agent entity is used as the parent for all spawned sub-agents.
 *
 * The Spawn tool descriptor is injected into ModelRequest.tools, making it visible
 * to the LLM. When called, it resolves the named agent, spawns it in-process,
 * and returns the output as the tool result.
 */
export function createSpawnToolProvider(config: SpawnToolProviderConfig): ComponentProvider {
  const resolvedPolicy = config.spawnPolicy ?? DEFAULT_SPAWN_POLICY;

  return {
    name: "spawn-tool-provider",
    attach: async (agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      const spawnFn = createAgentSpawnFn({
        resolver: config.resolver,
        base: {
          parentAgent: agent,
          spawnLedger: config.spawnLedger,
          spawnPolicy: resolvedPolicy,
        },
        adapter: config.adapter,
        manifestTemplate: config.manifestTemplate,
        inheritedMiddleware: config.inheritedMiddleware,
        ...(config.reportStore !== undefined ? { reportStore: config.reportStore } : {}),
      });

      const tool: Tool = {
        descriptor: {
          name: "Spawn",
          description:
            "Delegate a task to a specialized sub-agent. The sub-agent runs to completion and returns its output. Use this to parallelize work or leverage domain-specific agents.",
          inputSchema: {
            type: "object",
            properties: {
              agentName: {
                type: "string",
                description:
                  'Name of the agent to spawn (e.g. "researcher", "coder", "reviewer"). Must match a known agent definition.',
              },
              description: {
                type: "string",
                description: "The task for the spawned agent to perform.",
              },
              systemPrompt: {
                type: "string",
                description: "Optional additional system instructions for the spawned agent.",
              },
              maxTurns: {
                type: "number",
                description: "Maximum conversation turns before stopping.",
              },
              maxTokens: {
                type: "number",
                description: "Maximum tokens per model call.",
              },
              nonInteractive: {
                type: "boolean",
                description: "If true, the agent cannot prompt the user for input.",
              },
              toolDenylist: {
                type: "array",
                items: { type: "string" },
                description: "Tool names to exclude from the spawned agent.",
              },
            },
            required: ["agentName", "description"],
          } as JsonObject,
        },
        origin: "primordial",
        policy: DEFAULT_UNSANDBOXED_POLICY,
        execute: async (args: JsonObject, options?: ToolExecuteOptions): Promise<unknown> => {
          const result = await spawnFn({
            agentName: String(args.agentName ?? ""),
            description: String(args.description ?? ""),
            signal: options?.signal ?? AbortSignal.timeout(300_000), // 5 min default
            ...(args.systemPrompt !== undefined ? { systemPrompt: String(args.systemPrompt) } : {}),
            ...(args.maxTurns !== undefined ? { maxTurns: Number(args.maxTurns) } : {}),
            ...(args.maxTokens !== undefined ? { maxTokens: Number(args.maxTokens) } : {}),
            ...(args.nonInteractive !== undefined
              ? { nonInteractive: Boolean(args.nonInteractive) }
              : {}),
            ...(Array.isArray(args.toolDenylist)
              ? { toolDenylist: args.toolDenylist as string[] }
              : {}),
          });

          return result.ok
            ? { output: result.output }
            : { error: result.error.message, code: result.error.code };
        },
      };

      return new Map([["tool:Spawn", tool]]);
    },
  };
}
