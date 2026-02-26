/**
 * @koi/agent-monitor — Adversarial agent behavior detection middleware (Layer 2)
 *
 * Observes agent activity for anomalies: excessive tool calls, error spikes,
 * tool hammering, denied call accumulation, and latency outliers.
 * Fires onAnomaly callbacks without interrupting the agent.
 *
 * Satisfies the rogue-agents:no-agent-monitor doctor rule (OWASP ASI10).
 * Middleware name: "agent-monitor"
 *
 * Depends on @koi/core and @koi/errors only.
 */

export type { AgentMonitorConfig } from "./config.js";
export { DEFAULT_THRESHOLDS, validateAgentMonitorConfig } from "./config.js";
export { createAgentMonitorMiddleware } from "./monitor.js";
export type { AnomalySignal, LatencyStats, SessionMetricsSummary } from "./types.js";
