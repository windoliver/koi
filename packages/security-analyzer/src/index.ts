/**
 * @koi/security-analyzer — Dynamic risk classification for tool calls (Layer 2)
 *
 * Provides:
 *  - createRulesSecurityAnalyzer: fast synchronous pattern matcher
 *  - createCompositeSecurityAnalyzer: parallel multi-analyzer aggregator
 *  - createMonitorBridgeAnalyzer: elevates risk when agent-monitor anomalies present
 *  - withRiskAnalysis: HOF to wire an analyzer into an onAsk handler
 *  - maxRiskLevel, defaultExtractCommand: shared utilities
 *
 * Depends on @koi/core only. No L1 or peer L2 imports.
 */

export { createCompositeSecurityAnalyzer } from "./composite.js";
export { DEFAULT_ANALYZER_TIMEOUT_MS, withRiskAnalysis } from "./hof.js";
export type { AnomalySignalLike, MonitorBridgeConfig } from "./monitor-bridge.js";
export { createMonitorBridgeAnalyzer } from "./monitor-bridge.js";
export type { RulesAnalyzerConfig } from "./rules.js";
export {
  createRulesSecurityAnalyzer,
  DEFAULT_HIGH_RISK_PATTERNS,
  DEFAULT_MEDIUM_RISK_PATTERNS,
  defaultExtractCommand,
  maxRiskLevel,
} from "./rules.js";
