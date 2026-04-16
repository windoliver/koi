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
import type { SpawnChannelPolicy } from "./channel.js";
import type { JsonObject } from "./common.js";
import type { DeliveryPolicy } from "./delivery.js";
import type { AgentId, ToolDescriptor } from "./ecs.js";
import type { KoiError, Result } from "./errors.js";
import { RETRYABLE_DEFAULTS } from "./errors.js";
import type { ForgeScope } from "./forge-types.js";
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
   * Wall-clock deadline for the spawned agent in milliseconds.
   * When elapsed, the child's AbortSignal fires and the agent is stopped.
   * Default: 300,000 ms (5 minutes). Set to 0 to disable.
   */
  readonly timeoutMs?: number | undefined;
  /**
   * Absolute deadline as Unix timestamp (ms). Set by the spawn initiator to
   * `Date.now() + timeoutMs` so deferred/on-demand children can compute remaining
   * budget after setup time instead of starting a fresh full-duration timer.
   * When both `timeoutMs` and `absoluteDeadlineMs` are set, `absoluteDeadlineMs` wins.
   */
  readonly absoluteDeadlineMs?: number | undefined;
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
  /**
   * When true, this spawn is a fork — the child inherits all parent tools with no
   * filtering (equivalent to `toolAllowlist: ['*']`), and by default `agent_spawn`
   * is stripped from the child's inherited tool set to prevent recursive forks.
   *
   * To allow a fork child to spawn its own children (coordinator pattern), set
   * `allowNestedSpawn: true` — the child receives a fresh Spawn tool bound to
   * itself (bounded by the depth guard's `maxDepth`).
   *
   * Mutually exclusive with `toolAllowlist` (fork already implies full inheritance).
   * Compatible with `toolDenylist` (further restriction on top of fork defaults).
   *
   * If `maxTurns` is not set, `DEFAULT_FORK_MAX_TURNS` is applied automatically.
   *
   * Design rationale: fork has distinct semantics from a regular spawn with a
   * wildcard allowlist — it carries the recursion guard and the default turn cap,
   * enabling the engine to enforce both without relying on caller conventions.
   */
  readonly fork?: true | undefined;
  /**
   * When true AND `fork` is true, the forked child receives a fresh Spawn tool
   * for nested delegation (coordinator → researcher → coder pattern). Without
   * this flag, fork children are leaf workers that cannot spawn grandchildren.
   *
   * Bounded by the depth guard (`maxDepth`) — no unbounded recursion.
   * Ignored when `fork` is not set (non-fork children always receive Spawn
   * when manifest policy allows it).
   */
  readonly allowNestedSpawn?: true | undefined;
}

// ---------------------------------------------------------------------------
// Fork defaults
// ---------------------------------------------------------------------------

/**
 * Default maximum turns applied to forked children when `maxTurns` is not set.
 * Prevents runaway fork children from holding ledger slots indefinitely.
 * Aligns with the 200-turn cap used by CC's fork sub-agent implementation.
 */
export const DEFAULT_FORK_MAX_TURNS = 200;

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

// ---------------------------------------------------------------------------
// Spawn inheritance config
// ---------------------------------------------------------------------------

/**
 * Unified inheritance configuration for spawned child agents.
 *
 * Declares how a parent agent's capabilities (tools, channels, env) are
 * narrowed when spawning children. Children can only receive a subset of
 * parent capabilities — escalation is rejected.
 *
 * Moved to L0 so L2 packages can reference the type without importing L1.
 */
export interface SpawnInheritanceConfig {
  /** Tool scope filtering for inherited tools. */
  readonly tools?: {
    readonly scopeChecker?: (toolName: string) => ForgeScope | undefined;
  };
  /** Channel inheritance policy. */
  readonly channels?: SpawnChannelPolicy;
  /** Environment variable inheritance with overrides. */
  readonly env?: {
    /** Key-value overrides. Set value to undefined to narrow (remove) a parent key. */
    readonly overrides?: Readonly<Record<string, string | undefined>>;
  };
  /** Priority for the child agent (0–39, default 10). */
  readonly priority?: number;
}

// ---------------------------------------------------------------------------
// Canonical tool filter spec — shared representation for both manifest ceilings
// and per-spawn runtime options.
//
// Eliminates the structural mismatch between:
//   - ManifestSpawnConfig.tools: { policy?: ...; list?: ... }  (manifest YAML shape)
//   - SpawnRequest.toolDenylist / toolAllowlist               (two-field ergonomic API)
//
// L1 code normalizes both to ToolFilterSpec before applying filters.
// ---------------------------------------------------------------------------

/**
 * Canonical representation of a tool filter: a policy paired with an explicit list.
 *
 * Both fields are required in this normalized form so callers never need to
 * handle `undefined` policy or `undefined` list after normalization.
 */
export interface ToolFilterSpec {
  readonly policy: "allowlist" | "denylist";
  readonly list: readonly string[];
}

/**
 * Normalizes a `ManifestSpawnConfig.tools` block to a canonical `ToolFilterSpec`.
 *
 * When `tools` is absent, returns `undefined` (no ceiling declared).
 * Missing `policy` defaults to `"denylist"`. Missing `list` defaults to `[]`.
 */
export function toolFilterFromManifest(
  tools:
    | { readonly policy?: "allowlist" | "denylist"; readonly list?: readonly string[] }
    | undefined,
): ToolFilterSpec | undefined {
  if (tools === undefined) return undefined;
  return {
    policy: tools.policy ?? "denylist",
    list: tools.list ?? [],
  };
}

/**
 * Normalizes the tool filter fields of a `SpawnRequest` to a canonical `ToolFilterSpec`.
 *
 * When neither `toolAllowlist` nor `toolDenylist` is set, returns `undefined`
 * (no per-spawn filter declared — inherit manifest ceiling only).
 *
 * Note: callers must ensure `validateSpawnRequest` has passed before calling this,
 * since it guards against both fields being set simultaneously.
 */
export function toolFilterFromSpawnRequest(request: SpawnRequest): ToolFilterSpec | undefined {
  if (request.toolAllowlist !== undefined) {
    return { policy: "allowlist", list: request.toolAllowlist };
  }
  if (request.toolDenylist !== undefined) {
    return { policy: "denylist", list: request.toolDenylist };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Spawn request validation
// ---------------------------------------------------------------------------

/**
 * Validates a SpawnRequest for structural correctness before use.
 *
 * Catches configuration errors early (at request-construction time) rather
 * than at spawn time, with clear actionable error messages.
 *
 * Checks:
 * - `toolAllowlist` and `toolDenylist` are mutually exclusive
 * - `fork: true` and `toolAllowlist` are mutually exclusive (fork implies full inheritance)
 */
export function validateSpawnRequest(request: SpawnRequest): Result<SpawnRequest, KoiError> {
  if (request.toolAllowlist !== undefined && request.toolDenylist !== undefined) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message:
          "SpawnRequest cannot set both toolAllowlist and toolDenylist simultaneously — " +
          "they are mutually exclusive. Use toolAllowlist to restrict the child to a specific " +
          "set of tools, or toolDenylist to exclude specific tools from all inherited tools. " +
          "Remove one of the two fields.",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }
  if (request.fork === true && request.toolAllowlist !== undefined) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message:
          "SpawnRequest cannot set both fork and toolAllowlist — they are mutually exclusive. " +
          "fork inherits all parent tools (equivalent to a wildcard allowlist); setting " +
          "toolAllowlist would restrict that inheritance, defeating the purpose of fork. " +
          "Use toolDenylist instead to further narrow the fork's tool set.",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }
  return { ok: true, value: request };
}
