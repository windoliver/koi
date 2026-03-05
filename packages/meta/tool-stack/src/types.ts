/**
 * Tool stack configuration types.
 *
 * Each middleware slot is optional — omit to skip entirely.
 * Sandbox has a simplified config that hides policyFor/profileFor indirection.
 */

import type { ToolPolicy } from "@koi/core/ecs";
import type { KoiMiddleware } from "@koi/core/middleware";
import type { CallDedupConfig } from "@koi/middleware-call-dedup";
import type { ToolCallLimitConfig } from "@koi/middleware-call-limits";
import type { DegenerateMiddlewareConfig } from "@koi/middleware-degenerate";
import type { ToolAuditConfig } from "@koi/middleware-tool-audit";
import type { ToolRecoveryConfig } from "@koi/middleware-tool-recovery";
import type { ToolSelectorConfig } from "@koi/middleware-tool-selector";

/**
 * Simplified sandbox config — hides policyFor/profileFor indirection.
 *
 * The full SandboxMiddlewareConfig requires two closures (policyFor, profileFor)
 * that compose policy resolution and profile construction. For 90% of use cases,
 * users just need timeout + skip list. This config generates those closures
 * from flat values.
 *
 * Escape hatch: provide `policyFor` to override default policy resolution.
 */
export interface ToolStackSandboxConfig {
  /** Default timeout for sandboxed tools (default: 30_000 ms). */
  readonly defaultTimeoutMs?: number | undefined;
  /** Max output bytes before truncation (default: 1_048_576 = 1 MB). */
  readonly outputLimitBytes?: number | undefined;
  /** Grace period added to profile timeout (default: 5_000 ms). */
  readonly timeoutGraceMs?: number | undefined;
  /** Tools to skip sandboxing entirely (given unsandboxed policy). */
  readonly skipToolIds?: readonly string[] | undefined;
  /** Per-tool timeout overrides (toolId → timeoutMs). */
  readonly perToolTimeouts?: ReadonlyMap<string, number> | undefined;
  /** Escape hatch: override default policy resolution. */
  readonly policyFor?: ((toolId: string) => ToolPolicy | undefined) | undefined;
  /** Called when middleware detects a sandbox violation (timeout). */
  readonly onSandboxError?:
    | ((toolId: string, policy: ToolPolicy, code: string, message: string) => void)
    | undefined;
  /** Called after every sandboxed tool execution with metrics. */
  readonly onSandboxMetrics?:
    | ((
        toolId: string,
        policy: ToolPolicy,
        durationMs: number,
        outputBytes: number,
        truncated: boolean,
      ) => void)
    | undefined;
}

/**
 * Top-level tool stack configuration.
 *
 * Each middleware is optional — omit the key to exclude that middleware.
 * Only `limits` here is for tool call limits; model call limits are separate.
 */
export interface ToolStackConfig {
  /** Tool usage tracking and lifecycle signals (priority 100). */
  readonly audit?: ToolAuditConfig | undefined;
  /** Per-session/per-tool call count caps (priority 175). */
  readonly limits?: ToolCallLimitConfig | undefined;
  /** Recover structured tool calls from text patterns (priority 180). */
  readonly recovery?: ToolRecoveryConfig | undefined;
  /** Cache identical tool call results (priority 185). */
  readonly dedup?: CallDedupConfig | undefined;
  /** Enforce timeout + output truncation (priority 200). */
  readonly sandbox?: ToolStackSandboxConfig | undefined;
  /** Filter tools visible to the model (priority 420). */
  readonly selector?: ToolSelectorConfig | undefined;
  /** Variant selection + failover (priority 460). */
  readonly degenerate?: DegenerateMiddlewareConfig | undefined;
}

/** Return value of createToolStack(). */
export interface ToolStackBundle {
  /** Ordered middleware array, sorted by priority (ascending). */
  readonly middleware: readonly KoiMiddleware[];
}
