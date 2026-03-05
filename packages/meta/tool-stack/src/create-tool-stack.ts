/**
 * Tool stack factory — one call, sensible defaults, all wiring hidden.
 *
 * Composes up to 7 middleware for the tool execution lifecycle:
 *   tool-audit (100) → call-limits (175) → tool-recovery (180) →
 *   call-dedup (185) → sandbox (200) → tool-selector (420) → degenerate (460)
 */

import type { TrustTier } from "@koi/core/ecs";
import type { KoiMiddleware } from "@koi/core/middleware";
import type { ResourceLimits, SandboxProfile } from "@koi/core/sandbox-profile";
import { createCallDedupMiddleware } from "@koi/middleware-call-dedup";
import { createToolCallLimitMiddleware } from "@koi/middleware-call-limits";
import { createDegenerateMiddleware } from "@koi/middleware-degenerate";
import { createSandboxMiddleware } from "@koi/middleware-sandbox";
import { createToolAuditMiddleware } from "@koi/middleware-tool-audit";
import { createToolRecoveryMiddleware } from "@koi/middleware-tool-recovery";
import { createToolSelectorMiddleware } from "@koi/middleware-tool-selector";
import type { ToolStackBundle, ToolStackConfig, ToolStackSandboxConfig } from "./types.js";

/** Default timeout when no per-tool override is configured (30 s). */
const DEFAULT_SANDBOX_TIMEOUT_MS = 30_000;

/**
 * Maps simplified ToolStackSandboxConfig → SandboxMiddlewareConfig,
 * then delegates to createSandboxMiddleware.
 */
function createSandboxFromSimplifiedConfig(config: ToolStackSandboxConfig): KoiMiddleware {
  const {
    defaultTimeoutMs = DEFAULT_SANDBOX_TIMEOUT_MS,
    outputLimitBytes,
    timeoutGraceMs,
    skipToolIds,
    perToolTimeouts,
    tierFor: userTierFor,
    onSandboxError,
    onSandboxMetrics,
  } = config;

  const skipSet = skipToolIds !== undefined ? new Set(skipToolIds) : undefined;

  // skipToolIds takes precedence, then delegate to user's tierFor, then default to "sandbox"
  const tierFor = (toolId: string): TrustTier | undefined => {
    if (skipSet?.has(toolId) === true) {
      return "promoted";
    }
    if (userTierFor !== undefined) {
      return userTierFor(toolId);
    }
    return "sandbox";
  };

  const profileFor = (tier: TrustTier): SandboxProfile => {
    if (tier === "promoted") {
      return {
        tier,
        filesystem: {},
        network: { allow: true },
        resources: {},
      };
    }
    return {
      tier,
      filesystem: {},
      network: { allow: false },
      resources: { timeoutMs: defaultTimeoutMs },
    };
  };

  // Map perToolTimeouts to perToolOverrides (ResourceLimits partials)
  const perToolOverrides =
    perToolTimeouts !== undefined
      ? new Map<string, Partial<ResourceLimits>>(
          [...perToolTimeouts].map(([toolId, timeoutMs]) => [toolId, { timeoutMs }]),
        )
      : undefined;

  return createSandboxMiddleware({
    tierFor,
    profileFor,
    ...(outputLimitBytes !== undefined && { outputLimitBytes }),
    ...(timeoutGraceMs !== undefined && { timeoutGraceMs }),
    ...(perToolOverrides !== undefined && { perToolOverrides }),
    ...(onSandboxError !== undefined && { onSandboxError }),
    ...(onSandboxMetrics !== undefined && { onSandboxMetrics }),
  });
}

/**
 * Creates a tool execution lifecycle stack from optional middleware configs.
 *
 * Each middleware slot is independent — omit to skip entirely.
 * Returns middleware sorted by ascending priority.
 */
export function createToolStack(config: ToolStackConfig = {}): ToolStackBundle {
  const candidates: readonly (KoiMiddleware | undefined)[] = [
    config.audit !== undefined ? createToolAuditMiddleware(config.audit) : undefined,
    config.limits !== undefined ? createToolCallLimitMiddleware(config.limits) : undefined,
    config.recovery !== undefined ? createToolRecoveryMiddleware(config.recovery) : undefined,
    config.dedup !== undefined ? createCallDedupMiddleware(config.dedup) : undefined,
    config.sandbox !== undefined ? createSandboxFromSimplifiedConfig(config.sandbox) : undefined,
    config.selector !== undefined ? createToolSelectorMiddleware(config.selector) : undefined,
    config.degenerate !== undefined
      ? createDegenerateMiddleware(config.degenerate).middleware
      : undefined,
  ];

  const middleware = candidates
    .filter((mw): mw is KoiMiddleware => mw !== undefined)
    .toSorted((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

  return { middleware };
}
