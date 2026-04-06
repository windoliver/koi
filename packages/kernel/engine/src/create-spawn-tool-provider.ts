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
import { KoiRuntimeError } from "@koi/errors";

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
// Static spawn tool schema — computed once at module load, reused per attach()
// ---------------------------------------------------------------------------

/**
 * The JSON Schema for the Spawn tool's input. Pre-computed outside attach() so
 * it is not re-allocated on every agent assembly. The schema is immutable and
 * identical regardless of which agent is being assembled.
 *
 * Keep this in sync with createSpawnExecutor()'s arg parsing logic below.
 * If you add a field here, add the corresponding parse/validate in the executor.
 */
const SPAWN_TOOL_INPUT_SCHEMA: JsonObject = {
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
      description:
        "Tool names to exclude from the spawned agent. Mutually exclusive with toolAllowlist.",
    },
    toolAllowlist: {
      type: "array",
      items: { type: "string" },
      description:
        "Exclusive list of tool names the spawned agent may use (start-from-zero). Mutually exclusive with toolDenylist.",
    },
    fork: {
      type: "boolean",
      description:
        "If true, spawns the agent in fork mode: the child inherits all parent tools except agent_spawn (recursion guard). " +
        "Use for parallel workers that need the same capabilities as the parent. Mutually exclusive with toolAllowlist.",
    },
    timeoutMs: {
      type: "number",
      description:
        "Wall-clock deadline in milliseconds. Agent is stopped when elapsed. Default: 300000 (5 minutes).",
    },
  },
  required: ["agentName", "description"],
};

// ---------------------------------------------------------------------------
// Spawn executor — extracted for independent testability (Issue 2)
// ---------------------------------------------------------------------------

/**
 * Creates the Spawn tool's execute function bound to the given spawnFn.
 *
 * Extracted from the ComponentProvider's attach() closure so it can be unit-tested
 * without instantiating a full ComponentProvider. The schema is owned by
 * SPAWN_TOOL_INPUT_SCHEMA above — keep both in sync when adding fields.
 */
export function createSpawnExecutor(
  spawnFn: import("@koi/core").SpawnFn,
): (args: JsonObject, options?: ToolExecuteOptions) => Promise<unknown> {
  return async (args: JsonObject, options?: ToolExecuteOptions): Promise<unknown> => {
    // timeoutMs: 0 = disable (run until caller signal fires), >0 = wall-clock deadline
    const timeoutMs =
      args.timeoutMs !== undefined ? parseNonNegativeInt(args.timeoutMs, "timeoutMs") : 300_000; // 5 min default
    const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const signal =
      timeoutSignal !== undefined
        ? options?.signal !== undefined
          ? AbortSignal.any([options.signal, timeoutSignal])
          : timeoutSignal
        : (options?.signal ?? AbortSignal.timeout(0x7fff_ffff)); // no timeout: ~24 days max

    // Record absolute deadline so deferred/on-demand children compute remaining
    // budget rather than starting a fresh full-duration timer after setup.
    const absoluteDeadlineMs = timeoutMs > 0 ? Date.now() + timeoutMs : undefined;

    const result = await spawnFn({
      agentName: String(args.agentName ?? ""),
      description: String(args.description ?? ""),
      signal,
      timeoutMs,
      ...(absoluteDeadlineMs !== undefined ? { absoluteDeadlineMs } : {}),
      ...(args.systemPrompt !== undefined ? { systemPrompt: String(args.systemPrompt) } : {}),
      ...(args.maxTurns !== undefined
        ? { maxTurns: parsePositiveInt(args.maxTurns, "maxTurns") }
        : {}),
      ...(args.maxTokens !== undefined
        ? { maxTokens: parsePositiveInt(args.maxTokens, "maxTokens") }
        : {}),
      ...(args.nonInteractive !== undefined
        ? { nonInteractive: Boolean(args.nonInteractive) }
        : {}),
      ...(Array.isArray(args.toolDenylist) ? { toolDenylist: args.toolDenylist as string[] } : {}),
      ...(Array.isArray(args.toolAllowlist)
        ? { toolAllowlist: args.toolAllowlist as string[] }
        : {}),
      ...(args.fork === true ? { fork: true as const } : {}),
    });

    if (!result.ok) {
      // Propagate as a KoiRuntimeError so the engine's tool-failure path
      // (retries, interruption handling, observability) sees a real failure
      // rather than a success payload with embedded error fields.
      throw new KoiRuntimeError(result.error);
    }
    return { output: result.output };
  };
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
      // Pass self (via factory closure) as spawnProviderFactory so each spawned
      // child gets a fresh Spawn tool bound to itself, enabling recursive delegation
      // without a circular import between this module and createAgentSpawnFn.
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
        spawnProviderFactory: () => createSpawnToolProvider(config),
      });

      const tool: Tool = {
        descriptor: {
          name: "Spawn",
          description:
            "Delegate a task to a specialized sub-agent. The sub-agent runs to completion and returns its output. Use this to parallelize work or leverage domain-specific agents.",
          inputSchema: SPAWN_TOOL_INPUT_SCHEMA,
        },
        origin: "primordial",
        policy: DEFAULT_UNSANDBOXED_POLICY,
        execute: createSpawnExecutor(spawnFn),
      };

      return new Map([["tool:Spawn", tool]]);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a tool argument as a non-negative integer (>= 0), throwing KoiRuntimeError on invalid input.
 * Used for timeoutMs where 0 means "disable timeout".
 */
function parseNonNegativeInt(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw KoiRuntimeError.from(
      "VALIDATION",
      `Spawn tool argument "${field}" must be a non-negative integer (0 = disable), got: ${String(value)}`,
      { retryable: false },
    );
  }
  return n;
}

/**
 * Parse a tool argument as a positive integer, throwing KoiRuntimeError on invalid input.
 * Prevents NaN/Infinity from disabling iteration guards (comparison against NaN never fires).
 */
function parsePositiveInt(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw KoiRuntimeError.from(
      "VALIDATION",
      `Spawn tool argument "${field}" must be a positive integer, got: ${String(value)}`,
      { retryable: false },
    );
  }
  return n;
}
