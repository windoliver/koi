/**
 * Manifest adapter for @koi/agent-monitor.
 *
 * Reads manifest.middleware[].options (JSON-serializable values only) and
 * instantiates createAgentMonitorMiddleware. Callbacks (onAnomaly, onAnomalyError,
 * onMetrics) are supplied via AgentMonitorCallbacks — passed from createDefaultRegistry
 * so callers never need to touch createAgentMonitorMiddleware directly.
 *
 * agentDepth is supplied via RuntimeOpts.agentDepth, which createConfiguredKoi
 * auto-computes from parentPid so callers don't have to.
 */

import type { AnomalySignal, SessionMetricsSummary } from "@koi/agent-monitor";
import { createAgentMonitorMiddleware, validateAgentMonitorConfig } from "@koi/agent-monitor";
import type { KoiMiddleware, MiddlewareConfig, SessionId } from "@koi/core";
import type { RuntimeOpts } from "../registry.js";

/** Default anomaly handler: writes a structured line to stderr. */
function defaultOnAnomaly(signal: AnomalySignal): void {
  process.stderr.write(
    `[agent-monitor] kind=${signal.kind} session=${signal.sessionId} agent=${signal.agentId} turn=${signal.turnIndex}\n`,
  );
}

/**
 * Typed callbacks for @koi/agent-monitor — provided via createDefaultRegistry(callbacks)
 * since they are JS functions that cannot be expressed in JSON manifests.
 */
export interface AgentMonitorCallbacks {
  /** Called when an anomaly signal fires. Defaults to a structured stderr log. */
  readonly onAnomaly?: (signal: AnomalySignal) => void | Promise<void>;
  /** Called when onAnomaly throws, preventing callback errors from interrupting the agent. */
  readonly onAnomalyError?: (err: unknown, signal: AnomalySignal) => void;
  /** Called once at session end with a metrics summary snapshot. */
  readonly onMetrics?: (sessionId: SessionId, summary: SessionMetricsSummary) => void;
}

/**
 * Instantiates @koi/agent-monitor from a manifest MiddlewareConfig.
 * Throws on invalid options so misconfigured manifests fail fast at setup time.
 */
export function createAgentMonitorAdapter(
  config: MiddlewareConfig,
  opts?: RuntimeOpts,
  callbacks?: AgentMonitorCallbacks,
): KoiMiddleware {
  const rawConfig: unknown = {
    ...(config.options ?? {}),
    ...(opts?.agentDepth !== undefined ? { agentDepth: opts.agentDepth } : {}),
    // Callbacks overlay manifest options; onAnomaly falls back to structured stderr log.
    onAnomaly: callbacks?.onAnomaly ?? defaultOnAnomaly,
    ...(callbacks?.onAnomalyError !== undefined
      ? { onAnomalyError: callbacks.onAnomalyError }
      : {}),
    ...(callbacks?.onMetrics !== undefined ? { onMetrics: callbacks.onMetrics } : {}),
  };

  const result = validateAgentMonitorConfig(rawConfig);
  if (!result.ok) {
    throw new Error(`[starter] agent-monitor: invalid manifest options: ${result.error.message}`, {
      cause: result.error,
    });
  }

  return createAgentMonitorMiddleware(result.value);
}
