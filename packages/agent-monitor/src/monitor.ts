/**
 * createAgentMonitorMiddleware — adversarial agent behavior detection.
 *
 * Pure observer: fires onAnomaly callbacks, never throws or aborts.
 * Session state is isolated per sessionId and cleaned up in onSessionEnd.
 */

import type { SessionId } from "@koi/core/ecs";
import type {
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import { swallowError } from "@koi/errors";
import type { AgentMonitorConfig } from "./config.js";
import { DEFAULT_THRESHOLDS } from "./config.js";
import {
  checkDelegationDepth,
  checkDeniedCalls,
  checkDestructiveRate,
  checkErrorSpike,
  checkLatencyAnomaly,
  checkSessionDuration,
  checkTokenSpike,
  checkToolDiversity,
  checkToolPingPong,
  checkToolRate,
  checkToolRepeat,
} from "./detector.js";
import type { WelfordState } from "./latency.js";
import { WELFORD_INITIAL, welfordStddev, welfordUpdate } from "./latency.js";
import type { AnomalySignal, LatencyStats, SessionMetricsSummary } from "./types.js";

// ---------------------------------------------------------------------------
// Internal mutable session state — never exported
// ---------------------------------------------------------------------------

type SessionMetrics = {
  toolCallsThisTurn: number;
  totalToolCalls: number;
  totalModelCalls: number;
  totalErrorCalls: number;
  totalDeniedCalls: number;
  // Gap 1: destructive action tracking (per-turn counter + session total)
  destructiveCallsThisTurn: number;
  totalDestructiveCalls: number;
  // Gap 3: distinct tools per turn (Set resets in onBeforeTurn)
  distinctToolsThisTurn: Set<string>;
  anomalyCount: number;
  lastToolId: string | null;
  consecutiveRepeatCount: number;
  turnIndex: number;
  latency: WelfordState;
  // Gap 2: output token Welford state
  tokens: WelfordState;
  // Gap A: ping-pong detection (persists across turns)
  pingPongToolA: string | null;
  pingPongToolB: string | null;
  pingPongAltCount: number;
  // Gap B: session duration (set once in onSessionStart, fired at most once)
  sessionStartedAt: number;
  sessionDurationFired: boolean;
};

function createSessionMetrics(): SessionMetrics {
  return {
    toolCallsThisTurn: 0,
    totalToolCalls: 0,
    totalModelCalls: 0,
    totalErrorCalls: 0,
    totalDeniedCalls: 0,
    destructiveCallsThisTurn: 0,
    totalDestructiveCalls: 0,
    distinctToolsThisTurn: new Set(),
    anomalyCount: 0,
    lastToolId: null,
    consecutiveRepeatCount: 0,
    turnIndex: 0,
    latency: WELFORD_INITIAL,
    tokens: WELFORD_INITIAL,
    pingPongToolA: null,
    pingPongToolB: null,
    pingPongAltCount: 0,
    sessionStartedAt: Date.now(),
    sessionDurationFired: false,
  };
}

function buildSummary(
  sessionId: SessionId,
  agentId: string,
  m: SessionMetrics,
): SessionMetricsSummary {
  return {
    sessionId,
    agentId,
    totalToolCalls: m.totalToolCalls,
    totalModelCalls: m.totalModelCalls,
    totalErrorCalls: m.totalErrorCalls,
    totalDeniedCalls: m.totalDeniedCalls,
    totalDestructiveCalls: m.totalDestructiveCalls,
    anomalyCount: m.anomalyCount,
    turnCount: m.turnIndex,
    meanLatencyMs: m.latency.mean,
    latencyStddevMs: welfordStddev(m.latency),
    meanOutputTokens: m.tokens.mean,
    outputTokenStddev: welfordStddev(m.tokens),
  };
}

function buildLatencyStats(state: WelfordState): LatencyStats {
  return {
    count: state.count,
    mean: state.mean,
    stddev: welfordStddev(state),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAgentMonitorMiddleware(config: AgentMonitorConfig): KoiMiddleware {
  const thresholds = {
    maxToolCallsPerTurn:
      config.thresholds?.maxToolCallsPerTurn ?? DEFAULT_THRESHOLDS.maxToolCallsPerTurn,
    maxErrorCallsPerSession:
      config.thresholds?.maxErrorCallsPerSession ?? DEFAULT_THRESHOLDS.maxErrorCallsPerSession,
    maxConsecutiveRepeatCalls:
      config.thresholds?.maxConsecutiveRepeatCalls ?? DEFAULT_THRESHOLDS.maxConsecutiveRepeatCalls,
    maxDeniedCallsPerSession:
      config.thresholds?.maxDeniedCallsPerSession ?? DEFAULT_THRESHOLDS.maxDeniedCallsPerSession,
    latencyAnomalyFactor:
      config.thresholds?.latencyAnomalyFactor ?? DEFAULT_THRESHOLDS.latencyAnomalyFactor,
    minLatencySamples: config.thresholds?.minLatencySamples ?? DEFAULT_THRESHOLDS.minLatencySamples,
    maxDestructiveCallsPerTurn:
      config.thresholds?.maxDestructiveCallsPerTurn ??
      DEFAULT_THRESHOLDS.maxDestructiveCallsPerTurn,
    tokenSpikeAnomalyFactor:
      config.thresholds?.tokenSpikeAnomalyFactor ?? DEFAULT_THRESHOLDS.tokenSpikeAnomalyFactor,
    maxDistinctToolsPerTurn:
      config.thresholds?.maxDistinctToolsPerTurn ?? DEFAULT_THRESHOLDS.maxDistinctToolsPerTurn,
    maxPingPongCycles: config.thresholds?.maxPingPongCycles ?? DEFAULT_THRESHOLDS.maxPingPongCycles,
    maxSessionDurationMs:
      config.thresholds?.maxSessionDurationMs ?? DEFAULT_THRESHOLDS.maxSessionDurationMs,
    maxDelegationDepth:
      config.thresholds?.maxDelegationDepth ?? DEFAULT_THRESHOLDS.maxDelegationDepth,
  };

  // Gap 1: pre-build a Set for O(1) destructive-tool lookups
  const destructiveSet = new Set(config.destructiveToolIds ?? []);

  // Phase 2: pre-build a Set for O(1) spawn-tool lookups; depth check disabled if either is absent
  const spawnSet = new Set(config.spawnToolIds ?? []);
  const agentDepth = config.agentDepth;

  // Session state keyed by sessionId string (brands are strings at runtime)
  const sessions = new Map<string, SessionMetrics>();

  function fireAnomaly(signal: AnomalySignal, metrics: SessionMetrics): void {
    metrics.anomalyCount += 1;
    if (!config.onAnomaly) return;
    void Promise.resolve()
      .then(() => config.onAnomaly?.(signal))
      .catch((err: unknown) => {
        if (config.onAnomalyError) {
          config.onAnomalyError(err, signal);
        } else {
          swallowError(err, { package: "agent-monitor", operation: "onAnomaly" });
        }
      });
  }

  return {
    name: "agent-monitor",
    priority: 350,

    async onSessionStart(ctx: SessionContext): Promise<void> {
      sessions.set(ctx.sessionId as string, createSessionMetrics());
    },

    async onBeforeTurn(ctx: TurnContext): Promise<void> {
      const m = sessions.get(ctx.session.sessionId as string);
      if (!m) return;
      m.toolCallsThisTurn = 0;
      m.destructiveCallsThisTurn = 0;
      m.distinctToolsThisTurn = new Set();
      m.turnIndex = ctx.turnIndex + 1;
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const m = sessions.get(ctx.session.sessionId as string);
      if (!m) return next(request);

      m.totalToolCalls += 1;
      m.toolCallsThisTurn += 1;

      // Gap 3: track distinct tools this turn
      m.distinctToolsThisTurn.add(request.toolId);

      // Gap 1: track destructive calls this turn
      const isDestructive = destructiveSet.size > 0 && destructiveSet.has(request.toolId);
      if (isDestructive) {
        m.destructiveCallsThisTurn += 1;
        m.totalDestructiveCalls += 1;
      }

      // Update consecutive repeat tracking + Gap A: ping-pong detection
      if (m.lastToolId === request.toolId) {
        m.consecutiveRepeatCount += 1;
      } else {
        const prevToolId = m.lastToolId;
        m.consecutiveRepeatCount = 1;
        m.lastToolId = request.toolId;

        // Track A↔B alternation (persists across turns; resets only when a third tool appears)
        if (prevToolId !== null) {
          if (m.pingPongToolA === null) {
            // First tool transition — establish the candidate pair
            m.pingPongToolA = prevToolId;
            m.pingPongToolB = request.toolId;
            m.pingPongAltCount = 1;
          } else if (
            (prevToolId === m.pingPongToolA && request.toolId === m.pingPongToolB) ||
            (prevToolId === m.pingPongToolB && request.toolId === m.pingPongToolA)
          ) {
            // Continuing the A↔B alternation
            m.pingPongAltCount += 1;
          } else {
            // Third tool appeared — reset to the new pair
            m.pingPongToolA = prevToolId;
            m.pingPongToolB = request.toolId;
            m.pingPongAltCount = 1;
          }
        }
      }

      // Check tool rate
      const toolRateSignal = checkToolRate(m.toolCallsThisTurn, thresholds.maxToolCallsPerTurn);
      if (toolRateSignal !== null) {
        fireAnomaly(
          {
            ...toolRateSignal,
            sessionId: ctx.session.sessionId,
            agentId: ctx.session.agentId,
            timestamp: Date.now(),
            turnIndex: ctx.turnIndex,
          },
          m,
        );
      }

      // Check consecutive repeat
      const repeatSignal = checkToolRepeat(
        request.toolId,
        m.consecutiveRepeatCount,
        thresholds.maxConsecutiveRepeatCalls,
      );
      if (repeatSignal !== null) {
        fireAnomaly(
          {
            ...repeatSignal,
            sessionId: ctx.session.sessionId,
            agentId: ctx.session.agentId,
            timestamp: Date.now(),
            turnIndex: ctx.turnIndex,
          },
          m,
        );
      }

      // Gap 1: check destructive rate
      if (isDestructive) {
        const destructiveSignal = checkDestructiveRate(
          request.toolId,
          m.destructiveCallsThisTurn,
          thresholds.maxDestructiveCallsPerTurn,
        );
        if (destructiveSignal !== null) {
          fireAnomaly(
            {
              ...destructiveSignal,
              sessionId: ctx.session.sessionId,
              agentId: ctx.session.agentId,
              timestamp: Date.now(),
              turnIndex: ctx.turnIndex,
            },
            m,
          );
        }
      }

      // Phase 2: check delegation depth (only when agentDepth is configured and tool is a spawn tool)
      if (agentDepth !== undefined && spawnSet.size > 0 && spawnSet.has(request.toolId)) {
        const depthSignal = checkDelegationDepth(
          agentDepth,
          request.toolId,
          thresholds.maxDelegationDepth,
        );
        if (depthSignal !== null) {
          fireAnomaly(
            {
              ...depthSignal,
              sessionId: ctx.session.sessionId,
              agentId: ctx.session.agentId,
              timestamp: Date.now(),
              turnIndex: ctx.turnIndex,
            },
            m,
          );
        }
      }

      // Gap 3: check tool diversity
      const diversitySignal = checkToolDiversity(
        m.distinctToolsThisTurn.size,
        thresholds.maxDistinctToolsPerTurn,
      );
      if (diversitySignal !== null) {
        fireAnomaly(
          {
            ...diversitySignal,
            sessionId: ctx.session.sessionId,
            agentId: ctx.session.agentId,
            timestamp: Date.now(),
            turnIndex: ctx.turnIndex,
          },
          m,
        );
      }

      // Gap A: check ping-pong (only meaningful once two tools have been seen)
      if (m.pingPongToolA !== null && m.pingPongToolB !== null) {
        const pingPongSignal = checkToolPingPong(
          m.pingPongToolA,
          m.pingPongToolB,
          m.pingPongAltCount,
          thresholds.maxPingPongCycles,
        );
        if (pingPongSignal !== null) {
          fireAnomaly(
            {
              ...pingPongSignal,
              sessionId: ctx.session.sessionId,
              agentId: ctx.session.agentId,
              timestamp: Date.now(),
              turnIndex: ctx.turnIndex,
            },
            m,
          );
        }
      }

      let response: ToolResponse;
      try {
        response = await next(request);
      } catch (e: unknown) {
        m.totalErrorCalls += 1;
        // Check error spike after incrementing
        const errorSignal = checkErrorSpike(m.totalErrorCalls, thresholds.maxErrorCallsPerSession);
        if (errorSignal !== null) {
          fireAnomaly(
            {
              ...errorSignal,
              sessionId: ctx.session.sessionId,
              agentId: ctx.session.agentId,
              timestamp: Date.now(),
              turnIndex: ctx.turnIndex,
            },
            m,
          );
        }
        throw e;
      }

      // Check if response is a denial
      if (isDenied(response)) {
        m.totalDeniedCalls += 1;
        const deniedSignal = checkDeniedCalls(
          m.totalDeniedCalls,
          thresholds.maxDeniedCallsPerSession,
        );
        if (deniedSignal !== null) {
          fireAnomaly(
            {
              ...deniedSignal,
              sessionId: ctx.session.sessionId,
              agentId: ctx.session.agentId,
              timestamp: Date.now(),
              turnIndex: ctx.turnIndex,
            },
            m,
          );
        }
      }

      return response;
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const m = sessions.get(ctx.session.sessionId as string);
      if (!m) return next(request);

      m.totalModelCalls += 1;

      // Gap B: check session duration before the model call (fire-once guard)
      if (!m.sessionDurationFired) {
        const durationMs = Date.now() - m.sessionStartedAt;
        const durationSignal = checkSessionDuration(durationMs, thresholds.maxSessionDurationMs);
        if (durationSignal !== null) {
          m.sessionDurationFired = true;
          fireAnomaly(
            {
              ...durationSignal,
              sessionId: ctx.session.sessionId,
              agentId: ctx.session.agentId,
              timestamp: Date.now(),
              turnIndex: ctx.turnIndex,
            },
            m,
          );
        }
      }

      const startTime = Date.now();
      const response = await next(request);
      const latencyMs = Date.now() - startTime;

      m.latency = welfordUpdate(m.latency, latencyMs);

      const latencySignal = checkLatencyAnomaly(
        latencyMs,
        buildLatencyStats(m.latency),
        thresholds.latencyAnomalyFactor,
        thresholds.minLatencySamples,
      );
      if (latencySignal !== null) {
        fireAnomaly(
          {
            ...latencySignal,
            sessionId: ctx.session.sessionId,
            agentId: ctx.session.agentId,
            timestamp: Date.now(),
            turnIndex: ctx.turnIndex,
          },
          m,
        );
      }

      // Gap 2: track output tokens and check for spike
      if (response.usage !== undefined) {
        const outputTokens = response.usage.outputTokens;
        m.tokens = welfordUpdate(m.tokens, outputTokens);
        const tokenSignal = checkTokenSpike(
          outputTokens,
          buildLatencyStats(m.tokens),
          thresholds.tokenSpikeAnomalyFactor,
          thresholds.minLatencySamples,
        );
        if (tokenSignal !== null) {
          fireAnomaly(
            {
              ...tokenSignal,
              sessionId: ctx.session.sessionId,
              agentId: ctx.session.agentId,
              timestamp: Date.now(),
              turnIndex: ctx.turnIndex,
            },
            m,
          );
        }
      }

      return response;
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const m = sessions.get(ctx.session.sessionId as string);
      if (!m) {
        yield* next(request);
        return;
      }

      m.totalModelCalls += 1;

      // Gap B: check session duration before the model stream (fire-once guard)
      if (!m.sessionDurationFired) {
        const durationMs = Date.now() - m.sessionStartedAt;
        const durationSignal = checkSessionDuration(durationMs, thresholds.maxSessionDurationMs);
        if (durationSignal !== null) {
          m.sessionDurationFired = true;
          fireAnomaly(
            {
              ...durationSignal,
              sessionId: ctx.session.sessionId,
              agentId: ctx.session.agentId,
              timestamp: Date.now(),
              turnIndex: ctx.turnIndex,
            },
            m,
          );
        }
      }

      const startTime = Date.now();
      let outputTokens = 0;

      try {
        for await (const chunk of next(request)) {
          if (chunk.kind === "usage") {
            outputTokens = chunk.outputTokens;
          }
          yield chunk;
        }
      } finally {
        // Run post-stream checks regardless of how the stream ended.
        // Using finally ensures this code runs even when the consumer calls .return()
        // on this generator (e.g., the bridge exits after receiving the done chunk).
        const latencyMs = Date.now() - startTime;
        const { sessionId, agentId } = ctx.session;
        const timestamp = Date.now();
        const { turnIndex } = m;

        m.latency = welfordUpdate(m.latency, latencyMs);

        const latencySignal = checkLatencyAnomaly(
          latencyMs,
          buildLatencyStats(m.latency),
          thresholds.latencyAnomalyFactor,
          thresholds.minLatencySamples,
        );
        if (latencySignal !== null) {
          fireAnomaly({ ...latencySignal, sessionId, agentId, timestamp, turnIndex }, m);
        }

        if (outputTokens > 0) {
          m.tokens = welfordUpdate(m.tokens, outputTokens);
          const tokenSignal = checkTokenSpike(
            outputTokens,
            buildLatencyStats(m.tokens),
            thresholds.tokenSpikeAnomalyFactor,
            thresholds.minLatencySamples,
          );
          if (tokenSignal !== null) {
            fireAnomaly({ ...tokenSignal, sessionId, agentId, timestamp, turnIndex }, m);
          }
        }
      }
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      const m = sessions.get(ctx.sessionId as string);
      if (m && config.onMetrics) {
        const summary = buildSummary(ctx.sessionId, ctx.agentId, m);
        config.onMetrics(ctx.sessionId, summary);
      }
      sessions.delete(ctx.sessionId as string);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDenied(response: ToolResponse): boolean {
  if (response.metadata === undefined) return false;
  const meta = response.metadata as Record<string, unknown>;
  return meta.denied === true;
}
