import type {
  AgentId,
  AnomalyDetail,
  AnomalySignal,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelStreamHandler,
  PermissionDecision,
  PermissionQuery,
  SessionContext,
  SessionId,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { agentId as toAgentId, sessionId as toSessionId } from "@koi/core";
import {
  type AgentMonitorConfig,
  DEFAULT_THRESHOLDS,
  validateAgentMonitorConfig,
} from "./config.js";
import * as detect from "./detector.js";
import { buildKeywordPatterns } from "./keyword-patterns.js";
import { emptyStats, welfordUpdate } from "./latency.js";
import type { SessionMetrics, SessionMetricsSummary } from "./types.js";

export const AGENT_MONITOR_PRIORITY = 350;
const SESSION_END_DRIFT_TIMEOUT_MS = 100;

function freshMetrics(sessionId: SessionId, agentId: AgentId): SessionMetrics {
  return {
    sessionId,
    agentId,
    startedAt: Date.now(),
    turnIndex: 0,
    turnsSeen: 0,
    totalToolCalls: 0,
    totalModelCalls: 0,
    totalErrorCalls: 0,
    totalDeniedCalls: 0,
    totalDestructiveCalls: 0,
    anomalyCount: 0,
    toolCallsThisTurn: 0,
    distinctToolsThisTurn: new Set(),
    destructiveThisTurn: new Map(),
    goalDriftMatchedThisTurn: false,
    toolIdsThisTurn: [],
    lastToolId: null,
    consecutiveRepeat: 0,
    prevToolId: null,
    pingPongAltCount: 0,
    latency: emptyStats(),
    outputTokens: emptyStats(),
    pendingDrift: new Set(),
    closed: false,
  };
}

function snapshot(m: SessionMetrics): SessionMetricsSummary {
  return {
    sessionId: m.sessionId,
    agentId: m.agentId,
    totalToolCalls: m.totalToolCalls,
    totalModelCalls: m.totalModelCalls,
    totalErrorCalls: m.totalErrorCalls,
    totalDeniedCalls: m.totalDeniedCalls,
    totalDestructiveCalls: m.totalDestructiveCalls,
    anomalyCount: m.anomalyCount,
    turnCount: m.turnsSeen,
    meanLatencyMs: m.latency.mean,
    latencyStddevMs: m.latency.stddev,
    meanOutputTokens: m.outputTokens.mean,
    outputTokenStddev: m.outputTokens.stddev,
  };
}

export function createAgentMonitorMiddleware(rawConfig: AgentMonitorConfig): KoiMiddleware {
  const validated = validateAgentMonitorConfig(rawConfig);
  if (!validated.ok) {
    throw new Error(`agent-monitor config invalid: ${validated.error.message}`);
  }
  const config = validated.value;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(config.thresholds ?? {}) };
  const keywordPatterns = buildKeywordPatterns(config.objectives ?? []);
  const driftThreshold = config.goalDrift?.threshold ?? 1.0;
  const destructiveSet = new Set(config.destructiveToolIds ?? []);
  const spawnSet = new Set(config.spawnToolIds ?? []);
  const agentDepth = config.agentDepth ?? 0;
  const sessions = new Map<SessionId, SessionMetrics>();

  function makeSignal(detail: AnomalyDetail, m: SessionMetrics): AnomalySignal {
    return {
      sessionId: m.sessionId,
      agentId: m.agentId,
      timestamp: Date.now(),
      turnIndex: m.turnIndex,
      ...detail,
    };
  }

  function fire(detail: AnomalyDetail | null, m: SessionMetrics): void {
    if (detail === null) return;
    const signal = makeSignal(detail, m);
    m.anomalyCount++;
    const cb = config.onAnomaly;
    if (cb === undefined) return;
    Promise.resolve()
      .then(() => cb(signal))
      .catch((err: unknown) => {
        try {
          config.onAnomalyError?.(err, signal);
        } catch {
          // never throw from observer callbacks
        }
      });
  }

  function trackToolSequence(m: SessionMetrics, toolId: string): void {
    if (m.lastToolId === toolId) {
      m.consecutiveRepeat++;
    } else {
      m.consecutiveRepeat = 1;
    }
    if (m.lastToolId !== null && m.prevToolId !== null) {
      // ping-pong: A ↔ B alternation
      if (toolId === m.prevToolId && m.lastToolId !== toolId) {
        m.pingPongAltCount++;
      } else if (toolId !== m.lastToolId && toolId !== m.prevToolId) {
        m.pingPongAltCount = 0;
      }
    }
    m.prevToolId = m.lastToolId;
    m.lastToolId = toolId;
  }

  function fireWithTurn(detail: AnomalyDetail, m: SessionMetrics, turnIndex: number): void {
    // Drop late signals from async scorers that resolve after onSessionEnd —
    // otherwise we'd mutate counts on a discarded session and emit signals
    // for a session whose summary has already been exported.
    if (m.closed || sessions.get(m.sessionId) !== m) return;
    const signal: AnomalySignal = {
      sessionId: m.sessionId,
      agentId: m.agentId,
      timestamp: Date.now(),
      turnIndex,
      ...detail,
    };
    m.anomalyCount++;
    const cb = config.onAnomaly;
    if (cb === undefined) return;
    Promise.resolve()
      .then(() => cb(signal))
      .catch((err: unknown) => {
        try {
          config.onAnomalyError?.(err, signal);
        } catch {
          // never throw from observer callbacks
        }
      });
  }

  function evaluatePreviousTurnDrift(m: SessionMetrics): void {
    if (m.toolCallsThisTurn === 0 || (config.objectives?.length ?? 0) === 0) return;
    const objectives = config.objectives ?? [];
    // Snapshot per-turn inputs and the turn index BEFORE any await/reset, so
    // async scorers always see the data for the turn they are evaluating
    // and emitted signals carry that turn's index, not a later one.
    const snapshotToolIds: readonly string[] = [...m.toolIdsThisTurn];
    const snapshotTurnIndex = m.turnIndex;
    const snapshotMatched = m.goalDriftMatchedThisTurn;
    if (config.goalDrift?.scorer !== undefined) {
      const scorer = config.goalDrift.scorer;
      const p: Promise<void> = Promise.resolve()
        .then(() => scorer(snapshotToolIds, objectives))
        .then((score) => {
          if (score >= driftThreshold) {
            fireWithTurn(
              {
                kind: "goal_drift",
                driftScore: score,
                threshold: driftThreshold,
                objectives,
              },
              m,
              snapshotTurnIndex,
            );
          }
        })
        .catch((err: unknown) => {
          try {
            const synthetic: AnomalySignal = {
              sessionId: m.sessionId,
              agentId: m.agentId,
              timestamp: Date.now(),
              turnIndex: snapshotTurnIndex,
              kind: "goal_drift",
              driftScore: -1,
              threshold: driftThreshold,
              objectives,
            };
            config.onAnomalyError?.(err, synthetic);
          } catch {
            // never throw
          }
        })
        .finally(() => {
          m.pendingDrift.delete(p);
        });
      m.pendingDrift.add(p);
      return;
    }
    if (!snapshotMatched) {
      fireWithTurn(
        {
          kind: "goal_drift",
          driftScore: 1.0,
          threshold: driftThreshold,
          objectives,
        },
        m,
        snapshotTurnIndex,
      );
    }
  }

  function isPermissionDenialError(e: unknown): boolean {
    if (typeof e !== "object" || e === null) return false;
    if (!("code" in e)) return false;
    return e.code === "PERMISSION";
  }

  function isErrorOutput(output: unknown): boolean {
    // Require an explicit failure marker — many tools return structured
    // results with an `error` field or `ok:false` as part of their normal
    // output contract (e.g. web-fetch, browser nav). Only treat the explicit
    // kind:"error" envelope as an execution failure to avoid false-positive
    // error_spike anomalies on routine validation/permission responses.
    if (output === null || typeof output !== "object") return false;
    if (!("kind" in output)) return false;
    return output.kind === "error";
  }

  function isDeniedOutput(output: unknown): boolean {
    if (output === null || typeof output !== "object") return false;
    if ("kind" in output && (output as { kind?: unknown }).kind === "denied") return true;
    return false;
  }

  function getMetricsFor(ctx: { readonly session: SessionContext }): SessionMetrics | undefined {
    return sessions.get(ctx.session.sessionId);
  }

  return {
    name: "agent-monitor",
    priority: AGENT_MONITOR_PRIORITY,
    describeCapabilities: () => undefined,

    onSessionStart: async (ctx: SessionContext) => {
      const aid = toAgentId(ctx.agentId);
      sessions.set(ctx.sessionId, freshMetrics(toSessionId(String(ctx.sessionId)), aid));
    },

    onSessionEnd: async (ctx: SessionContext) => {
      const m = sessions.get(ctx.sessionId);
      if (m === undefined) return;
      // Evaluate the final turn's drift before exporting metrics — otherwise
      // signals for the last turn would be lost (no subsequent onBeforeTurn).
      evaluatePreviousTurnDrift(m);
      // Wait briefly for in-flight async scorers so their signals land before
      // we export the summary, but never block teardown on hung user code.
      // When the timeout wins, surface a synthetic onAnomalyError so operators
      // know the final-turn drift evaluation was dropped — late results are
      // then ignored by the session-presence gate in fireWithTurn().
      if (m.pendingDrift.size > 0) {
        const budget = config.goalDrift?.shutdownTimeoutMs ?? SESSION_END_DRIFT_TIMEOUT_MS;
        const dropped = m.pendingDrift.size;
        const settle = Promise.allSettled([...m.pendingDrift]).then(() => "settled" as const);
        const timeout = new Promise<"timeout">((resolve) => {
          setTimeout(() => resolve("timeout"), budget);
        });
        const result = await Promise.race([settle, timeout]);
        if (result === "timeout") {
          try {
            const synthetic: AnomalySignal = {
              sessionId: m.sessionId,
              agentId: m.agentId,
              timestamp: Date.now(),
              turnIndex: m.turnIndex,
              kind: "goal_drift",
              driftScore: -1,
              threshold: driftThreshold,
              objectives: config.objectives ?? [],
            };
            config.onAnomalyError?.(
              new Error(`agent-monitor: ${dropped} drift evaluation(s) dropped after ${budget}ms`),
              synthetic,
            );
          } catch {
            // never throw
          }
        }
      }
      // Close the session before exporting metrics so any drift scorer that
      // resolves after the timeout cannot mutate finalized state or emit
      // signals that contradict the summary already shipped.
      m.closed = true;
      try {
        config.onMetrics?.(ctx.sessionId, snapshot(m));
      } catch {
        // never throw
      }
      sessions.delete(ctx.sessionId);
    },

    onBeforeTurn: async (ctx: TurnContext) => {
      const m = getMetricsFor(ctx);
      if (m === undefined) return;
      // 1. Evaluate previous-turn goal drift before reset
      evaluatePreviousTurnDrift(m);
      // 2. Session duration check
      fire(detect.detectSessionDurationExceeded(m, thresholds, Date.now()), m);
      // 3. Reset per-turn state
      m.toolCallsThisTurn = 0;
      m.distinctToolsThisTurn.clear();
      m.destructiveThisTurn.clear();
      m.goalDriftMatchedThisTurn = false;
      m.toolIdsThisTurn = [];
      // Align internal counter with engine's turn index so signals tag the
      // turn the engine is actually running, not an off-by-one.
      m.turnIndex = ctx.turnIndex;
      m.turnsSeen++;
    },

    wrapToolCall: async (
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> => {
      const m = getMetricsFor(ctx);
      // Record the attempt BEFORE awaiting next() so thrown calls still
      // count toward rate / repetition / destructive / ping-pong detectors.
      if (m !== undefined) {
        m.totalToolCalls++;
        m.toolCallsThisTurn++;
        m.distinctToolsThisTurn.add(request.toolId);
        m.toolIdsThisTurn.push(request.toolId);
        trackToolSequence(m, request.toolId);
        if (destructiveSet.has(request.toolId)) {
          m.totalDestructiveCalls++;
          const c = (m.destructiveThisTurn.get(request.toolId) ?? 0) + 1;
          m.destructiveThisTurn.set(request.toolId, c);
        }
        if (keywordPatterns.length > 0) {
          for (const p of keywordPatterns) {
            if (p.test(request.toolId)) {
              m.goalDriftMatchedThisTurn = true;
              break;
            }
          }
        }
        fire(detect.detectToolRateExceeded(m, thresholds), m);
        fire(detect.detectToolRepeated(m, thresholds), m);
        fire(detect.detectToolDiversitySpike(m, thresholds), m);
        fire(detect.detectToolPingPong(m, thresholds), m);
        if (destructiveSet.has(request.toolId)) {
          fire(detect.detectIrreversibleActionRate(m, thresholds, request.toolId), m);
        }
        if (spawnSet.has(request.toolId)) {
          fire(detect.detectDelegationDepthExceeded(agentDepth, thresholds, request.toolId), m);
        }
      }
      let response: ToolResponse;
      try {
        response = await next(request);
      } catch (e: unknown) {
        // Permission denials throw KoiRuntimeError({code:"PERMISSION"});
        // they are already counted via onPermissionDecision, so don't
        // double-count them as execution errors.
        if (m !== undefined && !isPermissionDenialError(e)) {
          m.totalErrorCalls++;
          fire(detect.detectErrorSpike(m, thresholds), m);
        }
        throw e;
      }
      if (m !== undefined) {
        // Permission denials are counted authoritatively in
        // onPermissionDecision — never double-count them via response output.
        // A tool that returns {kind:"denied"} on its own (without going
        // through the permissions middleware) is still treated as an error.
        if (isErrorOutput(response.output) || isDeniedOutput(response.output)) {
          m.totalErrorCalls++;
          fire(detect.detectErrorSpike(m, thresholds), m);
        }
      }
      return response;
    },

    wrapModelStream: (
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> => {
      const m = getMetricsFor(ctx);
      const start = Date.now();
      let outputTokens = 0;
      const inner = next(request);
      return {
        [Symbol.asyncIterator]: async function* () {
          try {
            for await (const chunk of inner) {
              if (m !== undefined) {
                // Providers may report usage on `usage`, terminal `done`, or
                // even `error` chunks. Capture all three so token tracking
                // doesn't silently skip degraded paths or providers that
                // emit usage only at end-of-stream.
                if (chunk.kind === "usage") {
                  outputTokens = chunk.outputTokens;
                } else if (chunk.kind === "done" && chunk.response.usage !== undefined) {
                  outputTokens = chunk.response.usage.outputTokens;
                } else if (chunk.kind === "error" && chunk.usage !== undefined) {
                  outputTokens = chunk.usage.outputTokens;
                }
              }
              yield chunk;
            }
          } finally {
            if (m !== undefined) {
              const latencyMs = Date.now() - start;
              // Detect anomaly against pre-update stats so the outlier itself
              // does not widen the baseline used for its own threshold check.
              fire(detect.detectModelLatencyAnomaly(latencyMs, m.latency, thresholds), m);
              m.latency = welfordUpdate(m.latency, latencyMs);
              if (outputTokens > 0) {
                fire(detect.detectTokenSpike(outputTokens, m.outputTokens, thresholds), m);
                m.outputTokens = welfordUpdate(m.outputTokens, outputTokens);
              }
              m.totalModelCalls++;
            }
          }
        },
      };
    },

    onPermissionDecision: (
      ctx: TurnContext,
      _query: PermissionQuery,
      decision: PermissionDecision,
    ): void => {
      if (decision.effect !== "deny") return;
      const m = getMetricsFor(ctx);
      if (m === undefined) return;
      m.totalDeniedCalls++;
      fire(detect.detectDeniedToolCalls(m, thresholds), m);
    },
  };
}
