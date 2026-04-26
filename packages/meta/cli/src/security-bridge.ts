/**
 * Security bridge — wires @koi/governance-security analyzers into the TUI
 * store. Observe-phase middleware that runs on every tool call to detect
 * injection patterns, PII leakage, and behavioral anomalies.
 *
 * Pattern: mirror of governance-bridge.ts.
 */

import type {
  AgentId,
  AnomalySignal,
  JsonObject,
  KoiMiddleware,
  RiskAnalysis,
  RiskLevel,
  SessionId,
} from "@koi/core";
import {
  createAnomalyMonitor,
  createPiiDetector,
  createRulesAnalyzer,
  createSecurityScorer,
} from "@koi/governance-security";
import type { SecurityFinding, TuiStore } from "@koi/tui";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface SecurityBridgeConfig {
  readonly store: TuiStore;
  readonly sessionId: string;
}

export interface SecurityBridge {
  readonly middleware: KoiMiddleware;
  readonly nextTurn: () => void;
  readonly setSession: (sessionId: string) => void;
  readonly dispose: () => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSecurityBridge(config: SecurityBridgeConfig): SecurityBridge {
  // let: justified — mutated by setSession
  let sessionId = config.sessionId;

  const rulesAnalyzer = createRulesAnalyzer();
  const piiDetector = createPiiDetector(["email", "ssn", "api_key"]);
  const scorer = createSecurityScorer();

  function makeMonitor(sid: string): ReturnType<typeof createAnomalyMonitor> {
    return createAnomalyMonitor({
      sessionId: sid as SessionId,
      agentId: "security-bridge" as AgentId,
    });
  }
  // let: justified — recreated on setSession() to avoid cross-session state bleed
  let monitor = makeMonitor(sessionId);

  function nextId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function dispatchFinding(finding: SecurityFinding): void {
    config.store.dispatch({ kind: "add_security_finding", finding });
  }

  function buildFinding(
    toolName: string,
    riskLevel: RiskLevel,
    description: string,
    score: number,
    signals: readonly AnomalySignal[],
  ): SecurityFinding {
    // score is computed per-call; anomaly signals contribute to risk but are
    // captured separately — use the caller-supplied score.
    void signals;
    return {
      id: nextId(),
      ts: Date.now(),
      sessionId,
      toolName,
      riskLevel,
      description,
      score,
    };
  }

  const middleware: KoiMiddleware = {
    name: "security-bridge",
    phase: "observe",
    priority: 600,

    describeCapabilities(): undefined {
      return undefined;
    },

    async wrapToolCall(ctx, request, next) {
      const toolName = request.toolId;
      const args: JsonObject = request.input;
      const argsText = JSON.stringify(args);

      // 1. Record tool call before await to avoid TOCTOU on monitor state
      const anomalySignals = monitor.recordToolCall({ toolId: toolName, denied: false });
      // Static rules analysis — analyze() may return a Promise
      const analysis: RiskAnalysis = await Promise.resolve(rulesAnalyzer.analyze(toolName, args));
      const secScore = scorer.score(analysis, anomalySignals);

      if (analysis.findings.length > 0) {
        const description =
          analysis.findings.length === 1
            ? (analysis.findings[0]?.description ?? analysis.rationale)
            : `${analysis.findings.length} pattern(s): ${analysis.findings.map((f) => f.description).join("; ")}`;
        dispatchFinding(
          buildFinding(toolName, analysis.riskLevel, description, secScore.score, anomalySignals),
        );
      }

      // 2. PII detection
      const piiMatches = piiDetector.detect(argsText);
      if (piiMatches.length > 0) {
        const kinds = [...new Set(piiMatches.map((m) => m.kind))].join(", ");
        const piiScore = scorer.score({ riskLevel: "high", findings: [], rationale: "" }, []);
        dispatchFinding(
          buildFinding(toolName, "high", `PII detected in tool args: ${kinds}`, piiScore.score, []),
        );
      }

      // 3. Anomaly signals from monitor.recordToolCall (already recorded above)
      for (const signal of anomalySignals) {
        const sigScore = scorer.score({ riskLevel: "low", findings: [], rationale: "" }, [signal]);
        dispatchFinding(
          buildFinding(toolName, "high", `Anomaly: ${signal.kind}`, sigScore.score, [signal]),
        );
      }

      void ctx;
      return next(request);
    },
  };

  return {
    middleware,

    nextTurn(): void {
      monitor.nextTurn();
    },

    setSession(newSessionId: string): void {
      sessionId = newSessionId;
      monitor = makeMonitor(newSessionId);
    },

    dispose(): void {
      // No timers or open handles.
    },
  };
}
