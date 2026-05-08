import type {
  AgentId,
  CompositionExecutionError,
  CompositionExecutionResult,
  CompositionExecutor,
  CompositionPlan,
  CompositionStep,
  CompositionStepResult,
  CompositionTrigger,
  DeliveryPolicy,
  EngineInput,
  ForgeDemandSignal,
  SchedulerComponent,
} from "@koi/core";

export interface CompositionNotification {
  readonly channel: string;
  readonly message: string;
  readonly priority: "low" | "normal" | "high";
}

export interface CompositionSpawnRequest {
  readonly agentType: string;
  readonly input: EngineInput;
  readonly delivery: DeliveryPolicy;
}

export interface CompositionForgeRequest {
  readonly demand: ForgeDemandSignal;
}

export interface CompositionExecutionContext {
  readonly agentId: AgentId;
  readonly scheduler: SchedulerComponent;
  readonly notify: (notification: CompositionNotification) => Promise<unknown>;
  readonly spawn?: ((request: CompositionSpawnRequest) => Promise<unknown>) | undefined;
  readonly forge?: ((request: CompositionForgeRequest) => Promise<unknown>) | undefined;
}

type ExecutedStepResult = Extract<CompositionStepResult, { status: "executed" }>;

function approvalRequired(trigger: CompositionTrigger): CompositionExecutionResult {
  return {
    triggerId: trigger.id,
    status: "requires_approval",
    stepResults: [],
    executedCount: 0,
    error: {
      code: "APPROVAL_REQUIRED",
      message: "Composition plan requires approval before execution.",
    },
  };
}

function invalidTriggerPlanError(
  trigger: CompositionTrigger,
  plan: CompositionPlan,
): CompositionExecutionError & { readonly code: "INVALID_PLAN" } {
  return {
    code: "INVALID_PLAN",
    message: `plan triggerId ${plan.triggerId} does not match execute trigger ${trigger.id}`,
  };
}

function invalidPlanError(
  step: Extract<CompositionStep, { kind: "submit_task" | "create_schedule" }>,
  agentId: AgentId,
): CompositionExecutionError & { readonly code: "INVALID_PLAN" } {
  return {
    code: "INVALID_PLAN",
    message: `${step.kind} agentId ${String(step.agentId)} does not match attached agent ${String(agentId)}`,
    stepKind: step.kind,
  };
}

function stepUnsupported(
  step: Extract<CompositionStep, { kind: "spawn_agent" | "forge_skill" | "tool_call" }>,
): Extract<CompositionStepResult, { status: "unsupported" }> {
  return {
    step,
    status: "unsupported",
    error: {
      code: "STEP_UNSUPPORTED",
      message: `Unsupported composition step: ${step.kind}`,
      stepKind: step.kind,
    },
  };
}

function stepFailed(
  step: CompositionStep,
  cause: unknown,
): Extract<CompositionStepResult, { status: "failed" }> {
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    step,
    status: "failed",
    error: {
      code: "STEP_FAILED",
      message,
      stepKind: step.kind,
    },
  };
}

function failedResult(
  triggerId: string,
  prior: readonly ExecutedStepResult[],
  failure: Extract<CompositionStepResult, { status: "failed" }>,
): CompositionExecutionResult {
  return {
    triggerId,
    status: "failed",
    stepResults: [...prior, failure],
    executedCount: prior.length,
    error: failure.error,
  };
}

function unsupportedResult(
  triggerId: string,
  prior: readonly ExecutedStepResult[],
  unsupported: Extract<CompositionStepResult, { status: "unsupported" }>,
): CompositionExecutionResult {
  return {
    triggerId,
    status: "unsupported",
    stepResults: [...prior, unsupported],
    executedCount: prior.length,
    error: unsupported.error,
  };
}

export function createCompositionExecutor(
  context: CompositionExecutionContext,
): CompositionExecutor {
  return {
    async execute(
      trigger: CompositionTrigger,
      plan: CompositionPlan,
    ): Promise<CompositionExecutionResult> {
      if (plan.triggerId !== trigger.id) {
        return {
          triggerId: trigger.id,
          status: "failed",
          stepResults: [],
          executedCount: 0,
          error: invalidTriggerPlanError(trigger, plan),
        };
      }

      if (plan.requiresApproval) return approvalRequired(trigger);

      const stepResults: ExecutedStepResult[] = [];

      for (const step of plan.steps) {
        try {
          switch (step.kind) {
            case "submit_task": {
              if (step.agentId !== context.agentId) {
                return failedResult(trigger.id, stepResults, {
                  step,
                  status: "failed",
                  error: invalidPlanError(step, context.agentId),
                });
              }

              const output = await context.scheduler.submit(
                step.input,
                step.mode,
                step.taskOptions,
              );
              stepResults.push({ step, status: "executed", output });
              break;
            }

            case "create_schedule": {
              if (step.agentId !== context.agentId) {
                return failedResult(trigger.id, stepResults, {
                  step,
                  status: "failed",
                  error: invalidPlanError(step, context.agentId),
                });
              }

              const output = await context.scheduler.schedule(
                step.expression,
                step.input,
                step.mode,
                {
                  ...step.taskOptions,
                  ...(step.timezone === undefined ? {} : { timezone: step.timezone }),
                },
              );
              stepResults.push({ step, status: "executed", output });
              break;
            }

            case "notify_user": {
              const output = await context.notify({
                channel: step.channel,
                message: step.message,
                priority: step.priority,
              });
              stepResults.push({ step, status: "executed", output });
              break;
            }

            case "spawn_agent":
            case "forge_skill":
            case "tool_call":
              return unsupportedResult(trigger.id, stepResults, stepUnsupported(step));
          }
        } catch (cause) {
          return failedResult(trigger.id, stepResults, stepFailed(step, cause));
        }
      }

      return {
        triggerId: trigger.id,
        status: "executed",
        stepResults,
        executedCount: stepResults.length,
      };
    },
  };
}
