/**
 * Unified spawn types — single SpawnFn/SpawnRequest/SpawnResult contract (Decision 5B).
 *
 * Replaces the per-package spawn types (MinionSpawnFn, TaskSpawnFn, SpawnWorkerFn)
 * with a unified interface in L0. Each L2 package provides a thin adapter that
 * maps the unified types to its internal representation.
 *
 * This allows middleware, governance, and telemetry to operate on a single spawn
 * interface without knowing which L2 package initiated the spawn.
 */

import type { AgentManifest } from "./assembly.js";
import type { JsonObject } from "./common.js";
import type { DeliveryPolicy } from "./delivery.js";
import type { AgentId, ToolDescriptor } from "./ecs.js";
import type { KoiError } from "./errors.js";
import type { TaskItemId } from "./task-board.js";

// ---------------------------------------------------------------------------
// Spawn request
// ---------------------------------------------------------------------------

/**
 * Unified spawn request for all agent-spawning patterns.
 *
 * Covers parallel-minions (taskIndex), task-spawn (taskId),
 * orchestrator (agentId routing), and direct spawn.
 */
export interface SpawnRequest {
  /** Human-readable description of the task to perform. */
  readonly description: string;
  /** Name of the agent to spawn (resolved via AgentResolver or manifest). */
  readonly agentName: string;
  /** Optional inline manifest. If omitted, resolved by name. */
  readonly manifest?: AgentManifest | undefined;
  /** Abort signal for cooperative cancellation. */
  readonly signal: AbortSignal;
  /** Correlation index for parallel-minions result matching. */
  readonly taskIndex?: number | undefined;
  /** Task board item reference for orchestrator correlation. */
  readonly taskId?: TaskItemId | undefined;
  /** Target agent ID for copilot routing. */
  readonly agentId?: AgentId | undefined;
  /**
   * Delivery policy override for this spawn.
   * Takes precedence over manifest.delivery.
   */
  readonly delivery?: DeliveryPolicy | undefined;

  // ---------------------------------------------------------------------------
  // Sub-agent constraints (used by hook agents and sandboxed spawns)
  // ---------------------------------------------------------------------------

  /** System prompt for the spawned agent. */
  readonly systemPrompt?: string | undefined;
  /**
   * Additional tools to inject into the spawned agent.
   * These are merged with the agent's resolved tool set.
   */
  readonly additionalTools?: readonly ToolDescriptor[] | undefined;
  /** Tool names to exclude from the spawned agent's tool set. */
  readonly toolDenylist?: readonly string[] | undefined;
  /**
   * Tool names to exclusively allow from inherited parent tools.
   * Mutually exclusive with toolDenylist. Does not filter additionalTools
   * (those are always injected, e.g., HookVerdict for agent hooks).
   */
  readonly toolAllowlist?: readonly string[] | undefined;
  /** Maximum assistant turns before the agent is stopped. */
  readonly maxTurns?: number | undefined;
  /** Max tokens per model call for the spawned agent. */
  readonly maxTokens?: number | undefined;
  /**
   * When true, the spawned agent runs non-interactively — it cannot
   * prompt the user or request permissions. Equivalent to CC's `denyAsk`.
   */
  readonly nonInteractive?: boolean | undefined;
  /**
   * Expected structured output schema. When set, the engine should
   * enforce that the agent calls a tool matching this schema before completing.
   */
  readonly outputSchema?: JsonObject | undefined;
  /**
   * Explicit name of the required output tool. Used by the structured output
   * guard and verdict collector. Avoids brittle inference from additionalTools.
   */
  readonly requiredOutputToolName?: string | undefined;
}

// ---------------------------------------------------------------------------
// Spawn result
// ---------------------------------------------------------------------------

/**
 * Unified spawn result — success with output string, or failure with KoiError.
 */
export type SpawnResult =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly error: KoiError };

// ---------------------------------------------------------------------------
// Spawn function
// ---------------------------------------------------------------------------

/**
 * Unified spawn function signature.
 * Consumer provides this to wire L2 → L1 spawnChildAgent + runtime.run().
 */
export type SpawnFn = (request: SpawnRequest) => Promise<SpawnResult>;
