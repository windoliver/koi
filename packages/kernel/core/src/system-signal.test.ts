/**
 * Type-level tests for SystemSignal, CompositionSchedulerEvent, and SystemSignalSource.
 *
 * These are compile-time correctness tests — the TypeScript compiler IS the test runner.
 * A type error here means the contract is broken. No runtime assertions needed for
 * a types-only file.
 *
 * Covers:
 * 1. Exhaustiveness guard — every SystemSignal variant handled in a switch
 * 2. Structural conformance — a concrete mock satisfies SystemSignalSource
 * 3. ForgeDemandSignal inlining — Extract<SystemSignal, {kind:"forge_demand"}> extends ForgeDemandSignal
 * 4. CompositionSchedulerEvent subset — strictly narrower than SchedulerEvent
 */

import type { AnomalyDetail, AnomalySignal } from "./agent-anomaly.js";
import type { AgentDefinition } from "./agent-definition.js";
import type {
  CompositionExecutionError,
  CompositionExecutionResult,
  CompositionExecutor,
  CompositionStepResult,
  SuccessfulCompositionStepResult,
} from "./composition-executor.js";
import type {
  CompositionCapabilities,
  CompositionMoment,
  CompositionPlan,
  CompositionPlanner,
  CompositionStep,
  CompositionTrigger,
} from "./composition-planner.js";
import type { AgentId } from "./ecs.js";
import type { ForgeDemandSignal } from "./forge-demand.js";
import type { SchedulerEvent } from "./scheduler.js";
import type {
  CompositionSchedulerEvent,
  SystemSignal,
  SystemSignalSource,
} from "./system-signal.js";

// ---------------------------------------------------------------------------
// 1. Exhaustiveness guard
// ---------------------------------------------------------------------------
// If a new variant is added to SystemSignal without updating this switch,
// `const _: never = signal` becomes a compile error.

function _assertExhaustiveSystemSignal(signal: SystemSignal): void {
  switch (signal.kind) {
    case "governance":
      return;
    case "vfs":
      return;
    case "frontier":
      return;
    case "forge_demand":
      return;
    case "schedule":
      return;
    case "agent_lifecycle":
      return;
    case "anomaly":
      return;
    case "compaction":
      return;
    default: {
      const _: never = signal;
      void _;
    }
  }
}

// ---------------------------------------------------------------------------
// 5. AnomalyDetail exhaustiveness guard
// ---------------------------------------------------------------------------

function _assertExhaustiveAnomalyDetail(detail: AnomalyDetail): void {
  switch (detail.kind) {
    case "tool_rate_exceeded":
      return;
    case "error_spike":
      return;
    case "tool_repeated":
      return;
    case "model_latency_anomaly":
      return;
    case "denied_tool_calls":
      return;
    case "irreversible_action_rate":
      return;
    case "token_spike":
      return;
    case "tool_diversity_spike":
      return;
    case "tool_ping_pong":
      return;
    case "session_duration_exceeded":
      return;
    case "delegation_depth_exceeded":
      return;
    case "goal_drift":
      return;
    default: {
      const _: never = detail;
      void _;
    }
  }
}

// AnomalySignal wraps AnomalyBase & AnomalyDetail — kind field must be accessible
type _AnomalyHasKind = AnomalySignal extends { kind: string } ? true : false;
const _anomalyHasKind: _AnomalyHasKind = true;
void _anomalyHasKind;

// ---------------------------------------------------------------------------
// 6. VFS rename split — rename variant has from/to, not path
// ---------------------------------------------------------------------------

type _VfsWrite = Extract<SystemSignal, { kind: "vfs"; event: "write" }>;
type _VfsRename = Extract<SystemSignal, { kind: "vfs"; event: "rename" }>;

// write/delete variants must have path
type _WriteHasPath = _VfsWrite extends { path: string } ? true : false;
const _writePathCheck: _WriteHasPath = true;
void _writePathCheck;

// rename variant must have from/to AND path (path = from, for uniform access)
type _RenameHasPath = _VfsRename extends { path: string } ? true : false;
type _RenameHasFrom = _VfsRename extends { from: string } ? true : false;
type _RenameHasTo = _VfsRename extends { to: string } ? true : false;
const _renamePathCheck: _RenameHasPath = true;
const _renameFromCheck: _RenameHasFrom = true;
const _renameToCheck: _RenameHasTo = true;
void _renamePathCheck;
void _renameFromCheck;
void _renameToCheck;

// ---------------------------------------------------------------------------
// 2. Structural conformance — SystemSignalSource
// ---------------------------------------------------------------------------
// Compile error if the SystemSignalSource interface shape changes incompatibly.

const _sourceConformance: SystemSignalSource = {
  name: "test-source",
  watch: (_handler, _opts) => {
    // Verify options shape is accessible
    void _opts?.sampleRateMs;
    void _opts?.replay;
    void _opts?.onError;
    void _opts?.onDisconnect;
    return () => {};
  },
};
void _sourceConformance;

// ---------------------------------------------------------------------------
// 3. ForgeDemandSignal inlining — discriminant extraction
// ---------------------------------------------------------------------------
// Verifies that ForgeDemandSignal is correctly embedded in SystemSignal and
// that the discriminant kind:"forge_demand" narrows to the full ForgeDemandSignal
// interface (including confidence, suggestedBrickKind, context, emittedAt).

type _ForgeDemandExtracted = Extract<SystemSignal, { kind: "forge_demand" }>;
type _ForgeDemandCheck = _ForgeDemandExtracted extends ForgeDemandSignal ? true : false;
const _forgeDemandAssert: _ForgeDemandCheck = true;
void _forgeDemandAssert;

// ---------------------------------------------------------------------------
// 4. CompositionSchedulerEvent — strictly narrower than SchedulerEvent
// ---------------------------------------------------------------------------

// Must be assignable to SchedulerEvent (it is a subset)
type _IsSubset = CompositionSchedulerEvent extends SchedulerEvent ? true : false;
const _subsetCheck: _IsSubset = true;
void _subsetCheck;

// SchedulerEvent must NOT be assignable to CompositionSchedulerEvent
// (i.e., the full union is wider — strictly narrower is enforced)
type _IsStrictlyNarrow = SchedulerEvent extends CompositionSchedulerEvent ? false : true;
const _strictCheck: _IsStrictlyNarrow = true;
void _strictCheck;

// ---------------------------------------------------------------------------
// 7. Composition planning contracts
// ---------------------------------------------------------------------------

// CompositionMoment.kind must be accessible for discriminant narrowing.
type _MomentKindCheck = CompositionMoment["kind"];
const _momentKindCheck: _MomentKindCheck = "task_terminal";
void _momentKindCheck;

// Concrete trigger must satisfy the structural contract.
const _triggerConformance: CompositionTrigger = {
  id: "trigger-1",
  source: "governance",
  confidence: 0.8,
  moment: { kind: "capability_gap", missing: "diagnostic-agent" },
  suggestedCapabilities: ["spawn_agent"],
  context: {},
  emittedAt: 1,
};
void _triggerConformance;

// CompositionCapabilities should describe declarative spawnable agent definitions.
type _AgentsAreDefinitions = CompositionCapabilities["agents"] extends readonly AgentDefinition[]
  ? true
  : false;
const _agentsShapeCheck: _AgentsAreDefinitions = true;
void _agentsShapeCheck;

const _capabilitiesConformance: CompositionCapabilities = {
  tools: [],
  agents: [
    {
      agentType: "researcher",
      whenToUse: "Deep research on complex topics",
      source: "built-in",
      manifest: { name: "researcher", version: "1.0.0", model: { name: "sonnet" } },
      name: "researcher",
      description: "Deep research on complex topics",
    },
  ],
  schedules: [],
};
void _capabilitiesConformance;

// Spawn-related step variant should preserve the delivery contract and engine input.
type _SpawnStep = Extract<CompositionStep, { kind: "spawn_agent" }>;
const _spawnStepConformance: _SpawnStep = {
  kind: "spawn_agent",
  agentType: "researcher",
  input: { kind: "text", text: "spawn a helper agent" },
  delivery: { kind: "streaming" },
};
void _spawnStepConformance;

// Task submission should include scheduler mode and task options.
type _SubmitTaskStep = Extract<CompositionStep, { kind: "submit_task" }>;
const _submitTaskStepConformance: _SubmitTaskStep = {
  kind: "submit_task",
  agentId: "agent-1" as AgentId,
  mode: "dispatch",
  input: { kind: "text", text: "queue follow-up work" },
  taskOptions: { delayMs: 25, priority: 2, maxRetries: 3 },
};
void _submitTaskStepConformance;

// Schedule creation should carry scheduler mode, timezone, and task options.
type _CreateScheduleStep = Extract<CompositionStep, { kind: "create_schedule" }>;
const _createScheduleStepConformance: _CreateScheduleStep = {
  kind: "create_schedule",
  expression: "0 9 * * 1-5",
  agentId: "agent-2" as AgentId,
  mode: "spawn",
  input: { kind: "text", text: "morning check-in" },
  timezone: "America/Los_Angeles",
  taskOptions: { priority: 1, maxRetries: 1 },
};
void _createScheduleStepConformance;

// Planner must return a valid plan containing a notify_user step.
const _plannerConformance: CompositionPlanner = {
  async plan(
    trigger: CompositionTrigger,
    _capabilities: CompositionCapabilities,
  ): Promise<CompositionPlan> {
    const step: CompositionStep = {
      kind: "notify_user",
      channel: "inbox",
      message: trigger.id,
      priority: "normal",
    };

    return {
      triggerId: trigger.id,
      triggerEmittedAt: trigger.emittedAt,
      steps: [step],
      estimatedCost: 0,
      requiresApproval: false,
    };
  },
};
void _plannerConformance;

const _stepResultConformance: CompositionStepResult = {
  step: {
    kind: "notify_user",
    channel: "inbox",
    message: "hello",
    priority: "normal",
  },
  status: "executed",
  output: { delivered: true },
};
void _stepResultConformance;

const _unsupportedStepResultConformance: CompositionStepResult = {
  step: {
    kind: "forge_skill",
    demand: {
      id: "forge-demand-1",
      kind: "forge_demand",
      trigger: {
        kind: "capability_gap",
        requiredCapability: "forge_skill",
      },
      confidence: 0.6,
      suggestedBrickKind: "tool",
      context: {
        failureCount: 1,
        failedToolCalls: ["forge_skill"],
        taskDescription: "missing capability",
      },
      emittedAt: 2,
    },
  },
  status: "unsupported",
  error: {
    code: "STEP_UNSUPPORTED",
    message: "forge_skill is unsupported",
    stepKind: "forge_skill",
  },
};
void _unsupportedStepResultConformance;

const _failedStepResultConformance: CompositionStepResult = {
  step: {
    kind: "notify_user",
    channel: "inbox",
    message: "boom",
    priority: "normal",
  },
  status: "failed",
  error: {
    code: "STEP_FAILED",
    message: "notify failed",
    stepKind: "notify_user",
  },
};
void _failedStepResultConformance;

const _executionResultConformance: CompositionExecutionResult = {
  triggerId: "trigger-1",
  status: "executed",
  stepResults: [_stepResultConformance],
  executedCount: 1,
};
void _executionResultConformance;

const _executionErrorConformance: CompositionExecutionError = {
  code: "STEP_UNSUPPORTED",
  message: "spawn_agent is unsupported",
  stepKind: "spawn_agent",
};
void _executionErrorConformance;

type _ExecutedBranch = Extract<CompositionExecutionResult, { status: "executed" }>;
type _ApprovalBranch = Extract<CompositionExecutionResult, { status: "requires_approval" }>;
type _UnsupportedBranch = Extract<CompositionExecutionResult, { status: "unsupported" }>;
type _FailedBranch = Extract<CompositionExecutionResult, { status: "failed" }>;
type _ExecutedStepBranch = Extract<CompositionStepResult, { status: "executed" }>;
type _SkippedStepBranch = Extract<CompositionStepResult, { status: "skipped" }>;
type _UnsupportedStepBranch = Extract<CompositionStepResult, { status: "unsupported" }>;
type _FailedStepBranch = Extract<CompositionStepResult, { status: "failed" }>;

type _ExecutedBranchHasNoError = _ExecutedBranch extends { error?: undefined } ? true : false;
type _ExecutedBranchHasOnlySuccessfulSteps =
  _ExecutedBranch["stepResults"][number] extends SuccessfulCompositionStepResult ? true : false;
type _SuccessfulStepSubsetCoversExecuted =
  _ExecutedStepBranch extends SuccessfulCompositionStepResult ? true : false;
type _SuccessfulStepSubsetCoversSkipped = _SkippedStepBranch extends SuccessfulCompositionStepResult
  ? true
  : false;
type _ApprovalBranchHasApprovalError = _ApprovalBranch extends {
  error: { code: "APPROVAL_REQUIRED" };
}
  ? true
  : false;
type _ApprovalBranchIsFailClosed = _ApprovalBranch extends {
  stepResults: readonly [];
  executedCount: 0;
}
  ? true
  : false;
type _UnsupportedBranchHasStructuredError = _UnsupportedBranch extends {
  error: { code: "STEP_UNSUPPORTED" | "INVALID_PLAN" };
}
  ? true
  : false;
type _FailedBranchHasStructuredError = _FailedBranch extends {
  error: { code: "STEP_FAILED" | "INVALID_PLAN" };
}
  ? true
  : false;
type _UnsupportedStepHasStructuredError = _UnsupportedStepBranch extends {
  error: { code: "STEP_UNSUPPORTED" | "INVALID_PLAN" };
}
  ? true
  : false;
type _FailedStepHasStructuredError = _FailedStepBranch extends {
  error: { code: "STEP_FAILED" | "INVALID_PLAN" };
}
  ? true
  : false;

const _executedBranchHasNoError: _ExecutedBranchHasNoError = true;
const _executedBranchHasOnlySuccessfulSteps: _ExecutedBranchHasOnlySuccessfulSteps = true;
const _successfulStepSubsetCoversExecuted: _SuccessfulStepSubsetCoversExecuted = true;
const _successfulStepSubsetCoversSkipped: _SuccessfulStepSubsetCoversSkipped = true;
const _approvalBranchHasApprovalError: _ApprovalBranchHasApprovalError = true;
const _approvalBranchIsFailClosed: _ApprovalBranchIsFailClosed = true;
const _unsupportedBranchHasStructuredError: _UnsupportedBranchHasStructuredError = true;
const _failedBranchHasStructuredError: _FailedBranchHasStructuredError = true;
const _unsupportedStepHasStructuredError: _UnsupportedStepHasStructuredError = true;
const _failedStepHasStructuredError: _FailedStepHasStructuredError = true;
void _executedBranchHasNoError;
void _executedBranchHasOnlySuccessfulSteps;
void _successfulStepSubsetCoversExecuted;
void _successfulStepSubsetCoversSkipped;
void _approvalBranchHasApprovalError;
void _approvalBranchIsFailClosed;
void _unsupportedBranchHasStructuredError;
void _failedBranchHasStructuredError;
void _unsupportedStepHasStructuredError;
void _failedStepHasStructuredError;

// @ts-expect-error unsupported results must carry structured error metadata
const _invalidUnsupportedResult: CompositionExecutionResult = {
  triggerId: "trigger-invalid-unsupported",
  status: "unsupported",
  stepResults: [],
  executedCount: 0,
};
void _invalidUnsupportedResult;

// @ts-expect-error executed results cannot include unsupported step outcomes
const _invalidExecutedResultWithUnsupportedStep: CompositionExecutionResult = {
  triggerId: "trigger-invalid-executed-unsupported",
  status: "executed",
  stepResults: [_unsupportedStepResultConformance],
  executedCount: 0,
};
void _invalidExecutedResultWithUnsupportedStep;

// @ts-expect-error executed results cannot include failed step outcomes
const _invalidExecutedResultWithFailedStep: CompositionExecutionResult = {
  triggerId: "trigger-invalid-executed-failed",
  status: "executed",
  stepResults: [_failedStepResultConformance],
  executedCount: 0,
};
void _invalidExecutedResultWithFailedStep;

const _executorConformance: CompositionExecutor = {
  async execute(trigger, _plan): Promise<CompositionExecutionResult> {
    return {
      triggerId: trigger.id,
      status: "requires_approval",
      stepResults: [],
      executedCount: 0,
      error: {
        code: "APPROVAL_REQUIRED",
        message: "plan requires approval",
      },
    };
  },
};
void _executorConformance;
