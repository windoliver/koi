import type { CompositionTrigger, ForgeDemandSignal, ForgeTrigger, SystemSignal } from "@koi/core";

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
    case "vfs":
    case "agent_lifecycle":
    case "anomaly":
    case "compaction":
      return undefined;
  }
}
