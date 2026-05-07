import type {
  AnomalySignal,
  CompositionTrigger,
  ForgeDemandSignal,
  ForgeTrigger,
  SystemSignal,
} from "@koi/core";

function missingCapabilityFromForgeTrigger(trigger: ForgeTrigger): string {
  switch (trigger.kind) {
    case "capability_gap":
    case "composition_gap":
      return trigger.requiredCapability;
    case "agent_capability_gap":
      return trigger.agentType;
    case "agent_repeated_failure":
    case "agent_latency_degradation":
      return trigger.agentType;
    case "data_source_gap":
      return trigger.missingCapability;
    case "data_source_detected":
      return trigger.sourceName;
    case "repeated_failure":
    case "performance_degradation":
      return trigger.toolName;
    case "no_matching_tool":
      return trigger.query;
    case "complex_task_completed":
      return trigger.taskDescription;
    case "user_correction":
      return trigger.correctedToolCall;
    case "novel_workflow":
      return trigger.workflowDescription;
  }
}

function suggestedCapabilitiesFromForgeDemand(signal: ForgeDemandSignal): readonly string[] {
  return [`forge_${signal.suggestedBrickKind}`];
}

function mapForgeDemandToCompositionTrigger(signal: ForgeDemandSignal): CompositionTrigger {
  return {
    id: signal.id,
    source: "forge_demand",
    confidence: signal.confidence,
    moment: {
      kind: "capability_gap",
      missing: missingCapabilityFromForgeTrigger(signal.trigger),
    },
    suggestedCapabilities: suggestedCapabilitiesFromForgeDemand(signal),
    context: { forgeDemand: signal },
    emittedAt: signal.emittedAt,
  };
}

function mapTaskOutcome(
  event: Extract<SystemSignal, { kind: "schedule" }>["event"],
): "completed" | "failed" | "dead_letter" | "cancelled" {
  switch (event.kind) {
    case "task:completed":
      return "completed";
    case "task:failed":
      return "failed";
    case "task:dead_letter":
      return "dead_letter";
    case "task:cancelled":
      return "cancelled";
  }
}

function suggestedCapabilitiesForTaskOutcome(
  outcome: ReturnType<typeof mapTaskOutcome>,
): readonly string[] {
  switch (outcome) {
    case "completed":
    case "cancelled":
      return [];
    case "failed":
    case "dead_letter":
      return ["spawn_agent", "notify_user"];
  }
}

function metricShiftFromAnomaly(
  anomaly: AnomalySignal,
): { readonly metric: string; readonly improvement: number } | undefined {
  switch (anomaly.kind) {
    case "error_spike":
      return { metric: "error_count", improvement: anomaly.threshold - anomaly.errorCount };
    case "model_latency_anomaly":
      return { metric: "model_latency_ms", improvement: anomaly.mean - anomaly.latencyMs };
    case "token_spike":
      return { metric: "output_tokens", improvement: anomaly.mean - anomaly.outputTokens };
    case "goal_drift":
      if (anomaly.driftScore < 0) return undefined;
      return { metric: "goal_alignment", improvement: -anomaly.driftScore };
    case "tool_rate_exceeded":
      return { metric: "tool_rate", improvement: anomaly.threshold - anomaly.callsPerTurn };
    case "tool_repeated":
    case "denied_tool_calls":
    case "irreversible_action_rate":
    case "tool_diversity_spike":
    case "tool_ping_pong":
    case "session_duration_exceeded":
    case "delegation_depth_exceeded":
      return undefined;
  }
}

export function mapSystemSignalToCompositionTrigger(
  signal: SystemSignal,
): CompositionTrigger | undefined {
  switch (signal.kind) {
    case "governance":
      return {
        id: `governance:${signal.sensor}:${String(signal.emittedAt)}`,
        source: "governance",
        confidence: 1,
        moment: {
          kind: "threshold_crossed",
          sensor: signal.sensor,
          value: signal.value,
          limit: signal.limit,
          direction: signal.direction,
        },
        suggestedCapabilities: signal.sensor === "error_rate" ? ["spawn_agent", "notify_user"] : [],
        context: {},
        emittedAt: signal.emittedAt,
      };
    case "forge_demand":
      return mapForgeDemandToCompositionTrigger(signal);
    case "schedule": {
      const outcome = mapTaskOutcome(signal.event);
      return {
        id: `schedule:${String(signal.event.taskId)}:${String(signal.emittedAt)}`,
        source: "schedule",
        confidence: 1,
        moment: {
          kind: "task_terminal",
          taskId: signal.event.taskId,
          outcome,
        },
        suggestedCapabilities: suggestedCapabilitiesForTaskOutcome(outcome),
        context: { schedulerEvent: signal.event },
        emittedAt: signal.emittedAt,
      };
    }
    case "anomaly": {
      const shift = metricShiftFromAnomaly(signal.anomaly);
      if (shift === undefined) return undefined;

      return {
        id: `anomaly:${signal.anomaly.agentId}:${signal.anomaly.kind}:${String(signal.anomaly.timestamp)}`,
        source: "anomaly",
        confidence: 1,
        moment: {
          kind: "frontier_changed",
          metric: shift.metric,
          improvement: shift.improvement,
        },
        suggestedCapabilities: ["spawn_agent"],
        context: { anomaly: signal.anomaly },
        emittedAt: signal.anomaly.timestamp,
      };
    }
    case "vfs":
    case "agent_lifecycle":
    case "compaction":
      return undefined;
  }
}
